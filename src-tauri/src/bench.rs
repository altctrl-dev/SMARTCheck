//! Disk speed measurement with unbuffered I/O, the same technique as Microsoft DiskSpd and
//! CrystalDiskMark: Windows' file cache is bypassed (FILE_FLAG_NO_BUFFERING), so the numbers
//! reflect the drive and its connection rather than the computer's memory.
//!
//! Safety rules built in:
//! - Only a dedicated temporary file is ever written; it is created here and filled with real
//!   data before any read test (reads of never-written space on SMR/TRIM drives return
//!   instantly and would report fake speeds).
//! - Every test can be cancelled, and the caller never waits forever on a drive that has
//!   stopped responding: worker threads report through a channel with a deadline.

use std::alloc::{Layout, alloc_zeroed, dealloc};
use std::fs::OpenOptions;
use std::io;
use std::os::windows::fs::{FileExt, OpenOptionsExt};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const FILE_FLAG_NO_BUFFERING: u32 = 0x2000_0000;
const ALIGN: usize = 4096;
const PREPARE_CHUNK: usize = 4 * 1024 * 1024;

/// Size of the temporary test file.
pub const TEST_FILE_SIZE: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct TestSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub block: usize,
    /// Requests in flight at once (one worker thread each).
    pub depth: usize,
    pub random: bool,
    pub write: bool,
}

const MIB: usize = 1024 * 1024;
const KIB4: usize = 4096;

/// Reads first, then writes; random writes last because they leave SMR drives busy afterwards.
pub const TESTS: [TestSpec; 8] = [
    TestSpec { id: "seq1m_q8_read", label: "Sequential 1 MB, queue 8", block: MIB, depth: 8, random: false, write: false },
    TestSpec { id: "seq1m_q1_read", label: "Sequential 1 MB, queue 1", block: MIB, depth: 1, random: false, write: false },
    TestSpec { id: "rnd4k_q32_read", label: "Random 4 KB, queue 32", block: KIB4, depth: 32, random: true, write: false },
    TestSpec { id: "rnd4k_q1_read", label: "Random 4 KB, queue 1", block: KIB4, depth: 1, random: true, write: false },
    TestSpec { id: "seq1m_q8_write", label: "Sequential 1 MB, queue 8", block: MIB, depth: 8, random: false, write: true },
    TestSpec { id: "seq1m_q1_write", label: "Sequential 1 MB, queue 1", block: MIB, depth: 1, random: false, write: true },
    TestSpec { id: "rnd4k_q32_write", label: "Random 4 KB, queue 32", block: KIB4, depth: 32, random: true, write: true },
    TestSpec { id: "rnd4k_q1_write", label: "Random 4 KB, queue 1", block: KIB4, depth: 1, random: true, write: true },
];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    pub id: String,
    pub label: String,
    pub write: bool,
    /// Megabytes (10^6 bytes) per second, as drive makers and CrystalDiskMark report.
    pub mb_per_s: f64,
    pub iops: f64,
    pub avg_latency_ms: f64,
}

/// Page-aligned buffer, as unbuffered I/O requires.
struct AlignedBuf {
    ptr: *mut u8,
    layout: Layout,
}
unsafe impl Send for AlignedBuf {}

impl AlignedBuf {
    fn new(len: usize) -> Self {
        let layout = Layout::from_size_align(len, ALIGN).expect("valid layout");
        let ptr = unsafe { alloc_zeroed(layout) };
        assert!(!ptr.is_null(), "out of memory");
        AlignedBuf { ptr, layout }
    }
    fn as_slice(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr, self.layout.size()) }
    }
    fn as_mut_slice(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.ptr, self.layout.size()) }
    }
    /// Incompressible content, so SSD controllers can't shortcut the writes.
    fn fill_random(&mut self, seed: u64) {
        let mut rng = XorShift(seed | 1);
        for chunk in self.as_mut_slice().chunks_mut(8) {
            let v = rng.next().to_le_bytes();
            chunk.copy_from_slice(&v[..chunk.len()]);
        }
    }
}
impl Drop for AlignedBuf {
    fn drop(&mut self) {
        unsafe { dealloc(self.ptr, self.layout) }
    }
}

struct XorShift(u64);
impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
}

/// Unbuffered like DiskSpd's `-Su` and CrystalDiskMark: Windows' cache is bypassed, the drive's
/// own cache is not (forcing write-through would understate everyday write speed).
fn open(path: &Path, write: bool) -> io::Result<std::fs::File> {
    OpenOptions::new().read(true).write(write).custom_flags(FILE_FLAG_NO_BUFFERING).open(path)
}

fn interrupted() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "stopped")
}

/// Creates the test file and fills it with real data, reporting bytes written as it goes.
pub fn prepare_file(path: &Path, size: u64, cancel: &AtomicBool, mut progress: impl FnMut(u64)) -> io::Result<()> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .custom_flags(FILE_FLAG_NO_BUFFERING)
        .open(path)?;
    file.set_len(size)?;
    let mut buf = AlignedBuf::new(PREPARE_CHUNK);
    let mut offset = 0u64;
    while offset < size {
        if cancel.load(Ordering::Relaxed) {
            return Err(interrupted());
        }
        buf.fill_random(offset ^ 0x9E37_79B9_7F4A_7C15);
        file.seek_write(buf.as_slice(), offset)?;
        offset += PREPARE_CHUNK as u64;
        progress(offset.min(size));
    }
    // Flush the drive's cache too, so the data is really on the disk before reads are measured.
    file.sync_all()
}

struct WorkerResult {
    bytes: u64,
    ios: u64,
    latency: Duration,
    error: Option<io::Error>,
}

/// Runs one test: `warmup` is not counted, then measures for `duration`.
/// Gives up (without waiting for stuck threads) if the drive stops answering.
pub fn run_test(path: &Path, spec: &TestSpec, warmup: Duration, duration: Duration, cancel: Arc<AtomicBool>) -> io::Result<Measurement> {
    let size = std::fs::metadata(path)?.len();
    let blocks = (size / spec.block as u64).max(1);
    let cursor = Arc::new(AtomicU64::new(0));
    let start = Instant::now();
    let measure_from = start + warmup;
    let end = measure_from + duration;
    let (tx, rx) = mpsc::channel::<WorkerResult>();

    for worker in 0..spec.depth {
        let tx = tx.clone();
        let cursor = Arc::clone(&cursor);
        let cancel = Arc::clone(&cancel);
        let path = path.to_path_buf();
        let spec = *spec;
        std::thread::spawn(move || {
            let mut result = WorkerResult { bytes: 0, ios: 0, latency: Duration::ZERO, error: None };
            let file = match open(&path, spec.write) {
                Ok(f) => f,
                Err(e) => {
                    result.error = Some(e);
                    let _ = tx.send(result);
                    return;
                }
            };
            let mut buf = AlignedBuf::new(spec.block);
            if spec.write {
                buf.fill_random(0xA5A5_0000 + worker as u64);
            }
            let mut rng = XorShift(0x1234_5678_9ABC_DEF1 ^ ((worker as u64 + 1) * 0x9E37_79B9));
            loop {
                let now = Instant::now();
                if now >= end || cancel.load(Ordering::Relaxed) {
                    break;
                }
                let block_index = if spec.random { rng.next() % blocks } else { cursor.fetch_add(1, Ordering::Relaxed) % blocks };
                let offset = block_index * spec.block as u64;
                let t0 = Instant::now();
                let r = if spec.write { file.seek_write(buf.as_slice(), offset) } else { file.seek_read(buf.as_mut_slice(), offset) };
                let t1 = Instant::now();
                if let Err(e) = r {
                    result.error = Some(e);
                    break;
                }
                if t0 >= measure_from {
                    result.bytes += spec.block as u64;
                    result.ios += 1;
                    result.latency += t1 - t0;
                }
            }
            let _ = tx.send(result);
        });
    }
    drop(tx);

    // Wait for every worker, but never longer than the test plus a grace period.
    let deadline = end + Duration::from_secs(20);
    let (mut bytes, mut ios, mut latency) = (0u64, 0u64, Duration::ZERO);
    for _ in 0..spec.depth {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(r) => {
                if let Some(e) = r.error {
                    cancel.store(true, Ordering::Relaxed);
                    return Err(e);
                }
                bytes += r.bytes;
                ios += r.ios;
                latency += r.latency;
            }
            Err(_) => {
                cancel.store(true, Ordering::Relaxed);
                return Err(io::Error::new(io::ErrorKind::TimedOut, "the drive stopped responding"));
            }
        }
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(interrupted());
    }
    let secs = duration.as_secs_f64();
    Ok(Measurement {
        id: spec.id.to_string(),
        label: spec.label.to_string(),
        write: spec.write,
        mb_per_s: bytes as f64 / 1e6 / secs,
        iops: ios as f64 / secs,
        avg_latency_ms: if ios > 0 { latency.as_secs_f64() * 1000.0 / ios as f64 } else { 0.0 },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Small end-to-end run on the system temp folder: prepare, read, write, clean up.
    #[test]
    fn measures_a_small_file() {
        let path = std::env::temp_dir().join(format!("smartcheck-bench-test-{}.tmp", std::process::id()));
        let cancel = Arc::new(AtomicBool::new(false));
        let size = 16 * 1024 * 1024;
        let mut last = 0;
        prepare_file(&path, size, &cancel, |b| last = b).unwrap();
        assert_eq!(last, size);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), size);
        for spec in [TESTS[1], TESTS[3], TESTS[5]] {
            let m = run_test(&path, &spec, Duration::from_millis(50), Duration::from_millis(250), Arc::clone(&cancel)).unwrap();
            assert!(m.mb_per_s > 0.0 && m.iops > 0.0, "{}: {m:?}", spec.id);
        }
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn cancelled_prepare_stops() {
        let path = std::env::temp_dir().join(format!("smartcheck-bench-cancel-{}.tmp", std::process::id()));
        let cancel = AtomicBool::new(true);
        let err = prepare_file(&path, 8 * 1024 * 1024, &cancel, |_| {}).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::Interrupted);
        let _ = std::fs::remove_file(&path);
    }
}

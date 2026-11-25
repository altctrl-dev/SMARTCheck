//! The speed test: safety checks, a real 1 GB test file, eight CrystalDiskMark-style tests,
//! a watchdog on Windows' storage events, and cleanup that always runs.
//!
//! Progress goes to an `Emit` callback; the app forwards it to the window as "speed-progress" events.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::bench::{self, Measurement};
use crate::history::{SpeedRun, Store};
use crate::model::UsbLink;
use crate::{scan, smartctl, windows_info};

const MIN_FREE_BYTES: u64 = 3 * 1024 * 1024 * 1024;
const WARMUP: Duration = Duration::from_secs(1);
const MEASURE: Duration = Duration::from_secs(5);

static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpeedRequest {
    /// Serial number the test is meant for.
    pub key: String,
    pub device_name: String,
    pub device_type: String,
    /// Drive letter for the temporary file, e.g. "D".
    pub volume: String,
    pub usb_link: Option<UsbLink>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub step: String,
    /// "running", "done", "failed" or "skipped".
    pub state: String,
    pub message: String,
    pub percent: Option<f64>,
    pub measurement: Option<Measurement>,
}

pub fn cancel() {
    if let Some(flag) = CANCEL.lock().unwrap().as_ref() {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Receives each progress update (the app forwards them to the window as "speed-progress" events).
pub type Emit = Arc<dyn Fn(Progress) + Send + Sync>;

fn emit(tx: &Emit, step: &str, state: &str, message: impl Into<String>, percent: Option<f64>, measurement: Option<Measurement>) {
    tx(Progress { step: step.into(), state: state.into(), message: message.into(), percent, measurement });
}

/// Clears the "running" flag however the test ends.
struct RunGuard;
impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
        *CANCEL.lock().unwrap() = None;
    }
}

pub async fn run(tx: Emit, ctl: PathBuf, store: Store, req: SpeedRequest) -> Result<SpeedRun, String> {
    if RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("A speed test is already running.".into());
    }
    let _guard = RunGuard;
    let cancel = Arc::new(AtomicBool::new(false));
    *CANCEL.lock().unwrap() = Some(Arc::clone(&cancel));
    let letter: String = req.volume.chars().take(1).collect::<String>().to_ascii_uppercase();
    if letter.is_empty() || !letter.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err("No drive letter to put the test file on.".into());
    }

    // ---- Safety checks (nothing has been written yet; a failure here just stops)
    emit(&tx, "identity", "running", "Confirming this is the right drive", None, None);
    if let Err(e) = smartctl::verify_identity(&ctl, &req.device_name, &req.device_type, &req.key).await {
        emit(&tx, "identity", "failed", e.clone(), None, None);
        return Err(e);
    }
    emit(&tx, "identity", "done", format!("Serial {} confirmed", req.key), None, None);

    emit(&tx, "space", "running", format!("Checking free space on {letter}:"), None, None);
    let free = windows_info::free_space(&letter).unwrap_or(0);
    if free < MIN_FREE_BYTES {
        let e = format!("{letter}: needs at least 3 GB free for the temporary test file.");
        emit(&tx, "space", "failed", e.clone(), None, None);
        return Err(e);
    }
    emit(&tx, "space", "done", format!("{:.0} GB free on {letter}:", free as f64 / 1e9), None, None);

    emit(&tx, "health", "running", "Checking for problem sectors", None, None);
    let dev = smartctl::ScanDevice { name: req.device_name.clone(), dtype: req.device_type.clone(), index: None };
    let smart = match smartctl::read_device(&ctl, &dev).await {
        Ok(s) => s,
        Err(e) => {
            emit(&tx, "health", "failed", e.clone(), None, None);
            return Err(e);
        }
    };
    let raw = |id: u64| smart.attributes.iter().find(|a| a.id == id).map(|a| a.raw).unwrap_or(0);
    let problem_sectors = raw(197) + raw(198);
    let media_errors = smart.nvme.as_ref().map(|n| n.media_errors).unwrap_or(0);
    if smart.smart_passed == Some(false) || problem_sectors > 0 || media_errors > 0 {
        let e = "This drive has sectors it can’t read reliably. A speed test could stall on them and lock up the connection, so it was not started. Back up anything important first.".to_string();
        emit(&tx, "health", "failed", e.clone(), None, None);
        return Err(e);
    }
    if smart.self_test_remaining.is_some() {
        let e = "A self-test is running on this drive. Wait for it to finish, or stop it, before testing speed.".to_string();
        emit(&tx, "health", "failed", e.clone(), None, None);
        return Err(e);
    }
    emit(&tx, "health", "done", "No problem sectors", None, None);

    // ---- Watchdog: stop at the first storage reset or disk error Windows logs.
    let started_ms = scan::now_ms();
    let stop_reason: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let watchdog_done = Arc::new(AtomicBool::new(false));
    let watchdog = {
        let (cancel, reason, done) = (Arc::clone(&cancel), Arc::clone(&stop_reason), Arc::clone(&watchdog_done));
        tokio::spawn(async move {
            while !done.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_secs(2)).await;
                if let Ok(events) = windows_info::storage_events_since(started_ms).await {
                    if let Some(ev) = events.first() {
                        *reason.lock().unwrap() = Some(format!(
                            "Windows reported a storage problem ({} event {}) during the test, so it was stopped to protect the drive. If the drive stops responding, unplug it for 30 seconds.",
                            ev.source, ev.id
                        ));
                        cancel.store(true, Ordering::Relaxed);
                        break;
                    }
                }
            }
        })
    };

    let path = PathBuf::from(format!("{letter}:\\SMARTCheck-speedtest.tmp"));
    let mut results: Vec<Measurement> = Vec::new();
    let mut stopped: Option<String> = None;

    // ---- Test file: written for real, so read tests measure the disk, not empty space.
    let _ = std::fs::remove_file(&path);
    emit(&tx, "prepare", "running", "Writing a 1 GB test file", Some(0.0), None);
    let prep = {
        let (path, cancel, tx) = (path.clone(), Arc::clone(&cancel), Arc::clone(&tx));
        tokio::task::spawn_blocking(move || {
            let mut last_pct = -10.0;
            bench::prepare_file(&path, bench::TEST_FILE_SIZE, &cancel, |written| {
                let pct = written as f64 * 100.0 / bench::TEST_FILE_SIZE as f64;
                if pct - last_pct >= 5.0 || written == bench::TEST_FILE_SIZE {
                    last_pct = pct;
                    emit(&tx, "prepare", "running", "Writing a 1 GB test file", Some(pct), None);
                }
            })
        })
    };
    match tokio::time::timeout(Duration::from_secs(600), prep).await {
        Ok(Ok(Ok(()))) => emit(&tx, "prepare", "done", "Test file ready", Some(100.0), None),
        Ok(Ok(Err(e))) => stopped = Some(describe(&e, &cancel)),
        Ok(Err(e)) => stopped = Some(format!("Preparing the test file failed: {e}")),
        Err(_) => {
            cancel.store(true, Ordering::Relaxed);
            stopped = Some("Writing the test file took over 10 minutes, so the test was stopped.".into());
        }
    }
    if stopped.is_some() {
        emit(&tx, "prepare", "failed", stopped.clone().unwrap_or_default(), None, None);
    }

    // ---- The eight tests
    for spec in bench::TESTS.iter() {
        if stopped.is_some() || cancel.load(Ordering::Relaxed) {
            emit(&tx, spec.id, "skipped", "", None, None);
            continue;
        }
        emit(&tx, spec.id, "running", spec.label, None, None);
        let (path, spec_copy, c) = (path.clone(), *spec, Arc::clone(&cancel));
        let task = tokio::task::spawn_blocking(move || bench::run_test(&path, &spec_copy, WARMUP, MEASURE, c));
        match task.await {
            Ok(Ok(m)) => {
                emit(&tx, spec.id, "done", spec.label, None, Some(m.clone()));
                results.push(m);
            }
            Ok(Err(e)) => {
                let why = describe(&e, &cancel);
                emit(&tx, spec.id, "failed", why.clone(), None, None);
                stopped = Some(why);
            }
            Err(e) => {
                emit(&tx, spec.id, "failed", e.to_string(), None, None);
                stopped = Some(e.to_string());
            }
        }
    }

    // ---- Cleanup always runs, with a time limit in case the drive has stopped answering.
    watchdog_done.store(true, Ordering::Relaxed);
    watchdog.abort();
    if let Some(reason) = stop_reason.lock().unwrap().clone() {
        stopped = Some(reason);
    }
    emit(&tx, "cleanup", "running", "Deleting the test file", None, None);
    let cleanup = {
        let path = path.clone();
        tokio::task::spawn_blocking(move || std::fs::remove_file(&path).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }))
    };
    match tokio::time::timeout(Duration::from_secs(30), cleanup).await {
        Ok(Ok(Ok(()))) => emit(&tx, "cleanup", "done", "Test file deleted", None, None),
        _ => emit(&tx, "cleanup", "failed", format!("Couldn’t delete {} yet. Delete it once the drive responds.", path.display()), None, None),
    }

    let run = SpeedRun { at_ms: started_ms, volume: letter, link: req.usb_link, results, stopped };
    let _ = store.append_speed(&req.key, &run);
    Ok(run)
}

fn describe(e: &std::io::Error, cancel: &AtomicBool) -> String {
    match e.kind() {
        std::io::ErrorKind::Interrupted if cancel.load(Ordering::Relaxed) => "Stopped.".into(),
        std::io::ErrorKind::TimedOut => {
            "The drive stopped responding, so the test was stopped. If it stays unresponsive, unplug it for 30 seconds.".into()
        }
        _ => format!("The drive reported an error: {e}"),
    }
}

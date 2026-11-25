//! Diagnostic: SMARTCheck's speed tests on a 1 GB file in a folder, for comparison with other tools.
//!
//!   bench_compare <folder> prepare      create and fill the test file
//!   bench_compare <folder> <test id>    run one test on the existing file (e.g. seq1m_q8_read)
//!   bench_compare <folder>              prepare, then run all eight tests
//!
//! The file (<folder>\SMARTCheck-bench-compare.tmp) is left in place; delete it afterwards.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use smartcheck_lib::bench;

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args.next().expect("usage: bench_compare <folder> [prepare|<test id>]");
    let what = args.next();
    let path = std::path::Path::new(&dir).join("SMARTCheck-bench-compare.tmp");
    let cancel = Arc::new(AtomicBool::new(false));

    if what.is_none() || what.as_deref() == Some("prepare") {
        let started = Instant::now();
        bench::prepare_file(&path, bench::TEST_FILE_SIZE, &cancel, |_| {}).expect("prepare test file");
        eprintln!("prepared {} in {:.1} s", path.display(), started.elapsed().as_secs_f64());
        if what.is_some() {
            return;
        }
    }
    for spec in bench::TESTS.iter().filter(|s| what.as_deref().is_none_or(|w| w == s.id)) {
        let m = bench::run_test(&path, spec, Duration::from_secs(1), Duration::from_secs(5), Arc::clone(&cancel)).expect("run test");
        println!("{}\t{:.2}\t{:.1}\t{:.3}", m.id, m.mb_per_s, m.iops, m.avg_latency_ms);
    }
}

//! Diagnostic: exercises the Phase 2 back end on a real USB drive without the window.
//! Run from `src-tauri` as administrator:  cargo run --release --example phase2_check
//!
//! 1. Two scans with a throwaway history folder (the second must not add a duplicate check)
//! 2. A short self-test on the first USB drive, polled until it finishes
//! 3. The full speed test on that drive, printing each progress step
//! History goes to %TEMP%\smartcheck-phase2-check, not the app's real history.

use std::sync::Arc;
use std::time::{Duration, Instant};

use smartcheck_lib::history::Store;
use smartcheck_lib::{scan, smartctl, speedtest, windows_info};

#[tokio::main]
async fn main() {
    let cwd = std::env::current_dir().ok();
    let ctl = smartctl::locate(cwd.clone()).expect("smartctl not found");
    let dir = std::env::temp_dir().join("smartcheck-phase2-check");
    let _ = std::fs::remove_dir_all(&dir);
    let store = Store::new(dir.clone());
    let t0 = scan::now_ms();

    println!("== 1. Two scans with history");
    let first = scan::scan_all(cwd.clone(), Some(&store)).await;
    let second = scan::scan_all(cwd.clone(), Some(&store)).await;
    println!("elevated={} warnings={:?}", second.elevated, second.warnings);
    for d in &second.drives {
        let h = d.health.as_ref();
        println!(
            "  disk {} {} [{}] score={:?} status={:?} saved checks={}",
            d.disk_number,
            d.title,
            d.key,
            h.map(|h| h.score),
            h.map(|h| h.status),
            store.snapshots(&d.key).len()
        );
    }
    println!("  offline after 2nd scan: {} (first scan had {})", second.offline.len(), first.offline.len());

    let Some(drive) = second.drives.iter().find(|d| d.windows.usb.is_some() && d.smart.is_some()) else {
        println!("No USB drive with health data connected; stopping here.");
        return;
    };
    let s = drive.smart.as_ref().unwrap();
    println!("\nTarget: disk {} {} ({} {}), serial {}", drive.disk_number, drive.title, s.device_name, s.device_type, drive.key);

    println!("\n== 2. Short self-test");
    let started = Instant::now();
    match smartctl::verify_identity(&ctl, &s.device_name, &s.device_type, &drive.key).await {
        Ok(()) => println!("  identity confirmed"),
        Err(e) => {
            println!("  identity check failed: {e}");
            return;
        }
    }
    match smartctl::start_self_test(&ctl, &s.device_name, &s.device_type, "short").await {
        Ok(()) => println!("  started"),
        Err(e) => println!("  start failed: {e}"),
    }
    loop {
        tokio::time::sleep(Duration::from_secs(10)).await;
        match smartctl::self_test_status(&ctl, &s.device_name, &s.device_type).await {
            Ok(st) => {
                println!("  {:>4}s running={} remaining={:?} status={}", started.elapsed().as_secs(), st.running, st.remaining_percent, st.status);
                if !st.running {
                    break;
                }
            }
            Err(e) => println!("  status error: {e}"),
        }
        if started.elapsed() > Duration::from_secs(600) {
            println!("  gave up waiting after 10 minutes");
            break;
        }
    }
    let after = scan::scan_all(cwd.clone(), Some(&store)).await;
    if let Some(d) = after.drives.iter().find(|d| d.key == drive.key) {
        if let Some(t) = d.smart.as_ref().and_then(|s| s.self_tests.first()) {
            println!("  newest log entry: {} / {} / passed={:?} at hour {:?}", t.kind, t.status, t.passed, t.lifetime_hours);
        }
    }

    println!("\n== 3. Speed test");
    let vol = drive.windows.volumes.iter().max_by_key(|v| v.free_bytes.unwrap_or(0)).map(|v| v.letter.clone()).unwrap_or_default();
    let free_before = windows_info::free_space(&vol).unwrap_or(0);
    let tx: speedtest::Emit = Arc::new(|p: speedtest::Progress| {
        let m = p.measurement.map(|m| format!(" -> {:.2} MB/s, {:.0} IOPS, {:.2} ms", m.mb_per_s, m.iops, m.avg_latency_ms)).unwrap_or_default();
        let pct = p.percent.map(|x| format!(" {x:.0}%")).unwrap_or_default();
        if p.state != "running" || p.percent.is_none() || p.percent == Some(0.0) {
            println!("  [{:<8}] {:<16} {}{pct}{m}", p.state, p.step, p.message);
        }
    });
    let req = speedtest::SpeedRequest {
        key: drive.key.clone(),
        device_name: s.device_name.clone(),
        device_type: s.device_type.clone(),
        volume: vol.clone(),
        usb_link: drive.windows.usb.as_ref().map(|u| u.link),
    };
    match speedtest::run(tx, ctl.clone(), store.clone(), req).await {
        Ok(run) => println!("  finished: {} results, stopped={:?}", run.results.len(), run.stopped),
        Err(e) => println!("  refused: {e}"),
    }
    tokio::time::sleep(Duration::from_secs(5)).await;
    let free_after = windows_info::free_space(&vol).unwrap_or(0);
    println!("  free on {vol}: before {:.2} GB, 5 s after {:.2} GB", free_before as f64 / 1e9, free_after as f64 / 1e9);
    println!("  speed runs saved: {}", store.history(&drive.key).speed_runs.len());
    match windows_info::storage_events_since(t0).await {
        Ok(ev) => println!("  storage events during the whole check: {}", ev.len()),
        Err(e) => println!("  couldn't read events: {e}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
    println!("\nDone.");
}

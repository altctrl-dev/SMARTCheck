//! One full scan: list Windows disks, read each drive's S.M.A.R.T. data, assess health.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::model::*;
use crate::{elevation, health, smartctl, windows_info};

pub async fn scan_all(resource_dir: Option<std::path::PathBuf>) -> ScanResult {
    let elevated = elevation::is_elevated();
    let mut warnings = Vec::new();

    let disks = match windows_info::inventory().await {
        Ok(d) => d,
        Err(e) => {
            warnings.push(e);
            Vec::new()
        }
    };

    let ctl = smartctl::locate(resource_dir);
    let smartctl_version = match &ctl {
        Some(p) => smartctl::version(p).await,
        None => {
            warnings.push("The bundled smartctl program is missing, so drive health can’t be read.".into());
            None
        }
    };

    let mut devices = Vec::new();
    if let (Some(p), true) = (&ctl, elevated) {
        match smartctl::scan(p).await {
            Ok(d) => devices = d,
            Err(e) => warnings.push(e),
        }
    }

    let mut drives = Vec::new();
    // One drive at a time: parallel reads over a shared USB hub gain little and add risk.
    for win in disks {
        let dev = devices.iter().find(|d| d.index == Some(win.number));
        let (smart, smart_error) = match (&ctl, dev) {
            (Some(p), Some(dev)) => match smartctl::read_device(p, dev).await {
                Ok(s) => (Some(s), None),
                Err(e) => (None, Some(e)),
            },
            (Some(_), None) if !elevated => (None, Some("Administrator rights are needed to read this drive’s health.".into())),
            (Some(_), None) => (
                None,
                Some("This drive didn’t report any S.M.A.R.T. data. Its USB adapter may not pass it through.".into()),
            ),
            (None, _) => (None, Some("smartctl is missing, so this drive’s health can’t be read.".into())),
        };
        drives.push(build_report(win, smart, smart_error));
    }

    ScanResult { scanned_at_ms: now_ms(), elevated, smartctl_version, drives, warnings }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn build_report(win: WinDisk, smart: Option<SmartInfo>, smart_error: Option<String>) -> DriveReport {
    let kind = drive_kind(&win, smart.as_ref());
    let health = smart.as_ref().map(|s| health::assess(s, kind, win.usb.as_ref()));
    let capacity = smart.as_ref().and_then(|s| s.capacity_bytes).or(win.size_bytes).unwrap_or(0);
    let key = smart
        .as_ref()
        .and_then(|s| s.serial.clone())
        .unwrap_or_else(|| format!("disk{}", win.number));
    DriveReport {
        disk_number: win.number,
        key,
        title: title(&win, smart.as_ref(), capacity),
        capacity_label: capacity_label(capacity),
        kind,
        windows: win,
        smart,
        smart_error,
        health,
    }
}

fn drive_kind(win: &WinDisk, smart: Option<&SmartInfo>) -> DriveKind {
    if let Some(s) = smart {
        if s.protocol.eq_ignore_ascii_case("nvme") {
            return DriveKind::Nvme;
        }
        match s.rotation_rate {
            Some(0) => return DriveKind::Ssd,
            Some(_) => return DriveKind::Hdd,
            None => {}
        }
    }
    if win.bus_type.as_deref().is_some_and(|b| b.eq_ignore_ascii_case("nvme")) {
        return DriveKind::Nvme;
    }
    match win.media_type.as_deref() {
        Some("SSD") => DriveKind::Ssd,
        Some("HDD") => DriveKind::Hdd,
        _ => DriveKind::Unknown,
    }
}

/// "Western Digital Blue Mobile (SMR)" + 1 TB -> "WD Blue Mobile 1 TB"; otherwise the model name.
fn title(win: &WinDisk, smart: Option<&SmartInfo>, capacity: u64) -> String {
    let cap = capacity_label(capacity);
    if let Some(s) = smart {
        if let Some(fam) = &s.model_family {
            let base = fam.split('(').next().unwrap_or(fam).trim().replace("Western Digital", "WD");
            let lower = base.to_lowercase();
            let generic = lower.contains("based") || lower.contains("ssds") || lower.contains("family") || base.contains('/');
            if !base.is_empty() && !generic {
                return if cap.is_empty() { base } else { format!("{base} {cap}") };
            }
        }
        if let Some(m) = &s.model_name {
            return m.trim().replacen("WDC ", "WD ", 1);
        }
    }
    win.friendly_name.clone().unwrap_or_else(|| format!("Disk {}", win.number))
}

/// Decimal units, as printed on the box: 1,000,204,886,016 bytes -> "1 TB".
pub fn capacity_label(bytes: u64) -> String {
    if bytes == 0 {
        return String::new();
    }
    let tb = bytes as f64 / 1e12;
    if tb >= 1.0 {
        let r = (tb * 10.0).round() / 10.0;
        if (r - r.round()).abs() < 0.05 { format!("{} TB", r.round() as u64) } else { format!("{r:.1} TB") }
    } else {
        format!("{} GB", (bytes as f64 / 1e9).round() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn load(name: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn report(smart_file: &str, win: &Value) -> DriveReport {
        let v = load(smart_file);
        let smart = smartctl::parse(&v, "/dev/sdb", "sat");
        let raw: RawWinDisk = serde_json::from_value(win.clone()).unwrap();
        build_report(windows_info::to_win_disk(raw), Some(smart), None)
    }

    fn preview_windows() -> Vec<Value> {
        load("windows_preview.json").as_array().unwrap().clone()
    }

    #[test]
    fn capacity_labels() {
        assert_eq!(capacity_label(1_000_204_886_016), "1 TB");
        assert_eq!(capacity_label(512_110_190_592), "512 GB");
        assert_eq!(capacity_label(2_000_398_934_016), "2 TB");
        assert_eq!(capacity_label(1_500_301_910_016), "1.5 TB");
    }

    #[test]
    fn weak_sector_drive_is_caution_94() {
        let w = preview_windows();
        let r = report("wd_WXD2A5156PC4.json", &w[2]);
        let h = r.health.unwrap();
        assert_eq!(r.title, "WD Blue Mobile 1 TB");
        assert_eq!(r.kind, DriveKind::Hdd);
        assert_eq!(h.score, 94);
        assert_eq!(h.status, HealthStatus::Caution);
        assert_eq!(h.findings[0].title, "1 sector can’t be read reliably");
        assert!(h.findings[0].detail.contains("66,572"), "{}", h.findings[0].detail);
        assert_eq!(h.summary, "1 sector can’t be read reliably. Everything else looks normal.");
        let smart = r.smart.unwrap();
        assert_eq!(smart.temp_history.unwrap().values.len(), 128);
        assert_eq!(smart.bytes_written, Some(17_708_529 * 512));
    }

    #[test]
    fn healthy_drive_is_excellent_100() {
        let w = preview_windows();
        let r = report("wd_WXG2A511Z64P.json", &w[1]);
        let h = r.health.unwrap();
        assert_eq!(h.score, 100);
        assert_eq!(h.status, HealthStatus::Excellent);
        assert_eq!(h.findings[0].level, Level::Good);
        assert_eq!(h.summary, "No signs of wear or failure.");
    }

    #[test]
    fn usb2_link_is_flagged_without_hurting_health() {
        let w = preview_windows();
        let r = report("wd_WXE2A41CJUV4.json", &w[3]);
        let h = r.health.unwrap();
        assert_eq!(h.score, 100);
        assert_eq!(h.status, HealthStatus::Excellent);
        assert_eq!(h.findings[0].title, "Connected at USB 2.0 speed");
        assert_eq!(h.summary, "Connected at USB 2.0 speed. Everything else looks normal.");
    }

    /// `UPDATE_MOCK=1 cargo test write_preview_data` regenerates the browser preview data
    /// (src/mock/scan.json) from the fixtures, so the preview always matches the real engine.
    #[test]
    fn write_preview_data() {
        if std::env::var("UPDATE_MOCK").is_err() {
            return;
        }
        let w = preview_windows();
        let nvme: RawWinDisk = serde_json::from_value(w[0].clone()).unwrap();
        let mut drives = vec![build_report(
            windows_info::to_win_disk(nvme),
            None,
            Some("Preview data doesn’t include this drive. Run SMARTCheck as administrator to read it.".into()),
        )];
        drives.push(report("wd_WXG2A511Z64P.json", &w[1]));
        drives.push(report("wd_WXD2A5156PC4.json", &w[2]));
        drives.push(report("wd_WXE2A41CJUV4.json", &w[3]));
        let result = ScanResult {
            scanned_at_ms: 1_795_592_100_000, // 25 Nov 2026 13:05 IST

            elevated: true,
            smartctl_version: Some("7.5".into()),
            drives,
            warnings: vec![],
        };
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("src").join("mock").join("scan.json");
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        std::fs::write(out, serde_json::to_string_pretty(&result).unwrap()).unwrap();
    }
}

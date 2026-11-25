//! Drive history, kept per drive (by serial number) in the app's data folder:
//! - `<serial>.checks.jsonl`: one line per check, written when something changed or every 6 hours
//! - `<serial>.report.json`: the last full report, so unplugged drives can still be viewed
//! - `<serial>.speed.jsonl`: speed test results

use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::bench::Measurement;
use crate::model::*;

const RECORD_EVERY_MS: u64 = 6 * 3600 * 1000;
const MAX_OFFLINE: usize = 20;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub at_ms: u64,
    pub score: u8,
    pub status: HealthStatus,
    pub reallocated: u64,
    pub pending: u64,
    pub uncorrectable: u64,
    pub error_log: u64,
    pub media_errors: u64,
    pub percentage_used: Option<u64>,
    pub temperature: Option<i64>,
    pub power_on_hours: Option<u64>,
}

impl Snapshot {
    pub fn of(smart: &SmartInfo, health: &Health, at_ms: u64) -> Self {
        let raw = |id: u64| smart.attributes.iter().find(|a| a.id == id).map(|a| a.raw).unwrap_or(0);
        Snapshot {
            at_ms,
            score: health.score,
            status: health.status,
            reallocated: raw(5),
            pending: raw(197),
            uncorrectable: raw(198),
            error_log: smart.error_log_count,
            media_errors: smart.nvme.as_ref().map(|n| n.media_errors).unwrap_or(0),
            percentage_used: smart.nvme.as_ref().and_then(|n| n.percentage_used),
            temperature: smart.temperature,
            power_on_hours: smart.power_on_hours,
        }
    }

    /// Same health picture (temperature and hours aside).
    fn same_health(&self, o: &Snapshot) -> bool {
        self.score == o.score
            && self.status == o.status
            && self.reallocated == o.reallocated
            && self.pending == o.pending
            && self.uncorrectable == o.uncorrectable
            && self.error_log == o.error_log
            && self.media_errors == o.media_errors
            && self.percentage_used == o.percentage_used
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpeedRun {
    pub at_ms: u64,
    /// Drive letter the test file was written to, e.g. "D".
    pub volume: String,
    pub link: Option<UsbLink>,
    pub results: Vec<Measurement>,
    /// Why the run stopped early, if it did.
    pub stopped: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DriveHistory {
    pub snapshots: Vec<Snapshot>,
    pub speed_runs: Vec<SpeedRun>,
}

#[derive(Clone, Debug)]
pub struct Store {
    dir: PathBuf,
}

/// Serial numbers can contain characters that aren't allowed in file names.
fn safe(key: &str) -> String {
    key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

fn read_lines<T: DeserializeOwned>(path: &Path) -> Vec<T> {
    let Ok(file) = fs::File::open(path) else { return Vec::new() };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect()
}

fn append_line<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    let line = serde_json::to_string(value).map_err(io::Error::other)?;
    writeln!(file, "{line}")
}

impl Store {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Store { dir: app_data_dir.join("history") }
    }

    fn path(&self, key: &str, kind: &str) -> PathBuf {
        self.dir.join(format!("{}.{kind}", safe(key)))
    }

    pub fn snapshots(&self, key: &str) -> Vec<Snapshot> {
        read_lines(&self.path(key, "checks.jsonl"))
    }

    pub fn last_snapshot(&self, key: &str) -> Option<Snapshot> {
        self.snapshots(key).pop()
    }

    /// Saves a check if the health picture changed, or the last one is over 6 hours old.
    pub fn record(&self, key: &str, snap: &Snapshot) -> io::Result<bool> {
        fs::create_dir_all(&self.dir)?;
        if let Some(last) = self.last_snapshot(key) {
            if last.same_health(snap) && snap.at_ms.saturating_sub(last.at_ms) < RECORD_EVERY_MS {
                return Ok(false);
            }
        }
        append_line(&self.path(key, "checks.jsonl"), snap)?;
        Ok(true)
    }

    pub fn save_report(&self, report: &DriveReport) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let json = serde_json::to_string(report).map_err(io::Error::other)?;
        fs::write(self.path(&report.key, "report.json"), json)
    }

    /// Last saved reports of drives that aren't connected now, most recently checked first.
    pub fn offline_reports(&self, connected_keys: &[&str]) -> Vec<DriveReport> {
        let Ok(entries) = fs::read_dir(&self.dir) else { return Vec::new() };
        let connected: Vec<String> = connected_keys.iter().map(|k| safe(k)).collect();
        let mut reports: Vec<DriveReport> = entries
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".report.json"))
            .filter_map(|e| fs::read_to_string(e.path()).ok())
            .filter_map(|text| serde_json::from_str::<DriveReport>(&text).ok())
            .filter(|r| !connected.contains(&safe(&r.key)))
            .map(|mut r| {
                r.connected = false;
                r
            })
            .collect();
        reports.sort_by(|a, b| b.checked_at_ms.cmp(&a.checked_at_ms));
        reports.truncate(MAX_OFFLINE);
        reports
    }

    pub fn append_speed(&self, key: &str, run: &SpeedRun) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        append_line(&self.path(key, "speed.jsonl"), run)
    }

    pub fn history(&self, key: &str) -> DriveHistory {
        DriveHistory { snapshots: self.snapshots(key), speed_runs: read_lines(&self.path(key, "speed.jsonl")) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(at_ms: u64, pending: u64) -> Snapshot {
        Snapshot {
            at_ms,
            score: 100 - (pending as u8) * 2,
            status: if pending > 0 { HealthStatus::Caution } else { HealthStatus::Excellent },
            reallocated: 0,
            pending,
            uncorrectable: 0,
            error_log: 0,
            media_errors: 0,
            percentage_used: None,
            temperature: Some(30),
            power_on_hours: Some(10),
        }
    }

    #[test]
    fn records_only_changes_or_every_six_hours() {
        let dir = std::env::temp_dir().join(format!("smartcheck-history-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = Store::new(dir.clone());
        assert!(store.record("SN/1", &snap(1_000, 0)).unwrap());
        assert!(!store.record("SN/1", &snap(2_000, 0)).unwrap(), "unchanged within 6 hours");
        assert!(store.record("SN/1", &snap(3_000, 1)).unwrap(), "pending sector appeared");
        assert!(store.record("SN/1", &snap(3_000 + RECORD_EVERY_MS, 1)).unwrap(), "six hours later");
        let all = store.snapshots("SN/1");
        assert_eq!(all.len(), 3);
        assert_eq!(store.last_snapshot("SN/1").unwrap().pending, 1);
        let _ = fs::remove_dir_all(&dir);
    }
}

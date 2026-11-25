//! Data shared with the UI. Field names are serialized in camelCase to match `src/types.ts`.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    /// Milliseconds since the Unix epoch when the scan finished.
    pub scanned_at_ms: u64,
    pub elevated: bool,
    pub smartctl_version: Option<String>,
    pub drives: Vec<DriveReport>,
    /// Drives checked before that aren't connected now: their last saved report.
    #[serde(default)]
    pub offline: Vec<DriveReport>,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DriveReport {
    pub disk_number: u32,
    /// Stable identity: the drive's serial number when known.
    pub key: String,
    /// When this report was made (ms since the Unix epoch).
    #[serde(default)]
    pub checked_at_ms: u64,
    /// False for a saved report of a drive that isn't connected now.
    #[serde(default = "yes")]
    pub connected: bool,
    pub title: String,
    pub capacity_label: String,
    pub kind: DriveKind,
    pub windows: WinDisk,
    pub smart: Option<SmartInfo>,
    pub smart_error: Option<String>,
    pub health: Option<Health>,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DriveKind {
    Hdd,
    Ssd,
    Nvme,
    Unknown,
}

// ---------------------------------------------------------------- Windows side

/// One disk as reported by the PowerShell inventory script.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RawWinDisk {
    pub number: u32,
    pub friendly_name: Option<String>,
    pub bus_type: Option<String>,
    pub media_type: Option<String>,
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub is_system: bool,
    #[serde(default)]
    pub is_boot: bool,
    pub volumes: Option<Vec<Volume>>,
    pub usb: Option<RawUsb>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RawUsb {
    pub instance_id: String,
    pub location_paths: Option<String>,
    pub service: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub letter: String,
    pub label: Option<String>,
    pub file_system: Option<String>,
    pub size_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WinDisk {
    pub number: u32,
    pub friendly_name: Option<String>,
    pub bus_type: Option<String>,
    pub media_type: Option<String>,
    pub size_bytes: Option<u64>,
    pub is_system: bool,
    pub is_boot: bool,
    pub volumes: Vec<Volume>,
    pub usb: Option<UsbInfo>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsbInfo {
    pub vendor_id: Option<String>,
    pub product_id: Option<String>,
    /// Chip maker guessed from the USB vendor ID, e.g. "JMicron".
    pub chip: Option<String>,
    pub link: UsbLink,
    /// ACPI port name such as "SS01" (SuperSpeed) or "HS01" (Hi-Speed).
    pub port: Option<String>,
    /// "UAS" or "BOT" (classic USB mass storage).
    pub driver: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UsbLink {
    Usb3,
    Usb2,
    Unknown,
}

// ---------------------------------------------------------------- S.M.A.R.T. side

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SmartInfo {
    pub protocol: String,
    pub device_type: String,
    pub device_name: String,
    pub model_family: Option<String>,
    pub model_name: Option<String>,
    pub serial: Option<String>,
    pub firmware: Option<String>,
    pub capacity_bytes: Option<u64>,
    pub rotation_rate: Option<u64>,
    pub form_factor: Option<String>,
    pub sata_version: Option<String>,
    pub link_speed: Option<String>,
    pub link_speed_max: Option<String>,
    pub trim: Option<bool>,
    pub smr: bool,
    pub smart_passed: Option<bool>,
    pub power_on_hours: Option<u64>,
    pub power_cycles: Option<u64>,
    pub temperature: Option<i64>,
    pub temp_lifetime_min: Option<i64>,
    pub temp_lifetime_max: Option<i64>,
    /// Highest recommended operating temperature reported by the drive, if any.
    pub temp_limit: Option<i64>,
    pub temp_history: Option<TempHistory>,
    pub attributes: Vec<AtaAttribute>,
    pub error_log_count: u64,
    pub error_log: Vec<ErrorEntry>,
    /// Newest first.
    pub self_tests: Vec<SelfTest>,
    pub self_test_remaining: Option<u64>,
    pub self_test_minutes_short: Option<u64>,
    pub self_test_minutes_extended: Option<u64>,
    pub nvme: Option<NvmeHealth>,
    pub bytes_written: Option<u64>,
    pub bytes_read: Option<u64>,
    pub messages: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TempHistory {
    pub interval_minutes: u64,
    /// Oldest first; `None` where the drive has no reading.
    pub values: Vec<Option<i64>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AtaAttribute {
    pub id: u64,
    pub name: String,
    pub value: u64,
    pub worst: u64,
    pub thresh: u64,
    pub raw: u64,
    pub raw_string: String,
    pub prefail: bool,
    pub when_failed: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEntry {
    pub number: u64,
    pub lifetime_hours: Option<u64>,
    pub lba: Option<u64>,
    pub description: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SelfTest {
    pub kind: String,
    pub status: String,
    pub passed: Option<bool>,
    pub lifetime_hours: Option<u64>,
    pub lba_first_error: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NvmeHealth {
    pub critical_warning: u64,
    pub available_spare: Option<u64>,
    pub available_spare_threshold: Option<u64>,
    pub percentage_used: Option<u64>,
    pub media_errors: u64,
    pub error_log_entries: u64,
    pub unsafe_shutdowns: Option<u64>,
}

// ---------------------------------------------------------------- Assessment

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub score: u8,
    pub status: HealthStatus,
    pub summary: String,
    /// Most severe first.
    pub findings: Vec<Finding>,
    pub indicators: Vec<Indicator>,
    pub deductions: Vec<Deduction>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Excellent,
    Good,
    Fair,
    Caution,
    Poor,
    Failing,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Good,
    Info,
    Warning,
    Critical,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub level: Level,
    pub title: String,
    pub detail: String,
    pub action: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Indicator {
    pub label: String,
    pub value: String,
    pub level: Level,
    pub help: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Deduction {
    pub factor: String,
    pub rule: String,
    pub value: String,
    pub points: u32,
}

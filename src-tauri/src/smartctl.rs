//! Runs the bundled `smartctl.exe` (smartmontools) and parses its JSON output.
//! Every call is read-only and has a hard timeout, so a stuck USB drive can't hang the app.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;

use crate::model::{AtaAttribute, ErrorEntry, NvmeHealth, SelfTest, SmartInfo, TempHistory};

const SCAN_TIMEOUT_SECS: u64 = 30;
const DEVICE_TIMEOUT_SECS: u64 = 45;

/// A device found by `smartctl --scan-open`.
#[derive(Debug, Clone)]
pub struct ScanDevice {
    pub name: String,
    pub dtype: String,
    /// Windows physical disk number (`/dev/sda` = 0, `/dev/sdb` = 1, ...).
    pub index: Option<u32>,
}

/// Bundled copy first (installed app), then a system-wide smartmontools install (development).
pub fn locate(resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(dir) = resource_dir {
        let bundled = dir.join("smartmontools").join("smartctl.exe");
        if bundled.exists() {
            return Some(bundled);
        }
        let dev = dir.join("resources").join("smartmontools").join("smartctl.exe");
        if dev.exists() {
            return Some(dev);
        }
    }
    let system = PathBuf::from(r"C:\Program Files\smartmontools\bin\smartctl.exe");
    system.exists().then_some(system)
}

async fn run(path: &Path, args: &[&str], timeout_secs: u64) -> Result<Vec<u8>, String> {
    let mut cmd = tokio::process::Command::new(path);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let child = cmd.spawn().map_err(|e| format!("Couldn't start smartctl: {e}"))?;
    match tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await {
        Ok(Ok(out)) => Ok(out.stdout),
        Ok(Err(e)) => Err(format!("smartctl failed: {e}")),
        Err(_) => Err(format!(
            "The drive didn't answer within {timeout_secs} seconds. It may be busy, or its USB connection may be stuck."
        )),
    }
}

pub async fn version(path: &Path) -> Option<String> {
    let out = run(path, &["--version"], 10).await.ok()?;
    let text = String::from_utf8_lossy(&out);
    let first = text.lines().next()?;
    // "smartctl 7.5 2025-04-30 r5714 [...]" -> "7.5"
    first.split_whitespace().nth(1).map(str::to_string)
}

/// Maps "/dev/sdb" -> 1, "/dev/sdaa" -> 26, "/dev/pd3" -> 3.
pub fn device_index(name: &str) -> Option<u32> {
    if let Some(n) = name.strip_prefix("/dev/pd") {
        return n.parse().ok();
    }
    let letters = name.strip_prefix("/dev/sd")?;
    if letters.is_empty() || !letters.chars().all(|c| c.is_ascii_lowercase()) {
        return None;
    }
    let mut n: u32 = 0;
    for c in letters.chars() {
        n = n * 26 + (c as u32 - 'a' as u32 + 1);
    }
    Some(n - 1)
}

pub async fn scan(path: &Path) -> Result<Vec<ScanDevice>, String> {
    let out = run(path, &["--scan-open", "--json"], SCAN_TIMEOUT_SECS).await?;
    let v: Value = serde_json::from_slice(&out).map_err(|e| format!("Unexpected smartctl output: {e}"))?;
    let devices = v
        .pointer("/devices")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|d| {
                    let name = d.get("name")?.as_str()?.to_string();
                    let dtype = d.get("type").and_then(Value::as_str).unwrap_or("auto").to_string();
                    Some(ScanDevice { index: device_index(&name), name, dtype })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(devices)
}

pub async fn read_device(path: &Path, dev: &ScanDevice) -> Result<SmartInfo, String> {
    let out = run(path, &["-x", "--json", "-d", &dev.dtype, &dev.name], DEVICE_TIMEOUT_SECS).await?;
    let v: Value = serde_json::from_slice(&out).map_err(|e| format!("Unexpected smartctl output: {e}"))?;
    let info = parse(&v, &dev.name, &dev.dtype);
    if info.model_name.is_none() && info.serial.is_none() && info.smart_passed.is_none() {
        let why = if info.messages.is_empty() {
            "The drive returned no S.M.A.R.T. data.".to_string()
        } else {
            info.messages.join(" ")
        };
        return Err(why);
    }
    Ok(info)
}

// ---------------------------------------------------------------- JSON parsing

fn s(v: &Value, p: &str) -> Option<String> {
    v.pointer(p)
        .and_then(Value::as_str)
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
}
fn u(v: &Value, p: &str) -> Option<u64> {
    v.pointer(p).and_then(Value::as_u64)
}
fn i(v: &Value, p: &str) -> Option<i64> {
    v.pointer(p).and_then(Value::as_i64)
}
fn b(v: &Value, p: &str) -> Option<bool> {
    v.pointer(p).and_then(Value::as_bool)
}

/// "Error: UNC at LBA = 0x0001040c = 66572" -> 66572
fn lba_from_description(text: &str) -> Option<u64> {
    let idx = text.rfind('=')?;
    text[idx + 1..].trim().parse().ok()
}

fn bytes_from_attribute(attrs: &[AtaAttribute], names: &[(&str, u64)]) -> Option<u64> {
    for (name, unit) in names {
        if let Some(a) = attrs.iter().find(|a| a.name.eq_ignore_ascii_case(name)) {
            return a.raw.checked_mul(*unit);
        }
    }
    None
}

pub fn parse(v: &Value, device_name: &str, device_type: &str) -> SmartInfo {
    let protocol = s(v, "/device/protocol")
        .unwrap_or_else(|| if device_type == "nvme" { "NVMe".into() } else { "ATA".into() });

    let attributes: Vec<AtaAttribute> = v
        .pointer("/ata_smart_attributes/table")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|a| AtaAttribute {
                    id: u(a, "/id").unwrap_or(0),
                    name: s(a, "/name").unwrap_or_default(),
                    value: u(a, "/value").unwrap_or(0),
                    worst: u(a, "/worst").unwrap_or(0),
                    thresh: u(a, "/thresh").unwrap_or(0),
                    raw: u(a, "/raw/value").unwrap_or(0),
                    raw_string: s(a, "/raw/string").unwrap_or_default(),
                    prefail: b(a, "/flags/prefailure").unwrap_or(false),
                    when_failed: s(a, "/when_failed").unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();

    // ATA error log: the extended log (from -x) or the summary log.
    let elog = v
        .pointer("/ata_smart_error_log/extended")
        .or_else(|| v.pointer("/ata_smart_error_log/summary"));
    let error_log_count = elog.and_then(|e| u(e, "/count")).unwrap_or(0);
    let error_log = elog
        .and_then(|e| e.pointer("/table"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|e| {
                    let description = s(e, "/error_description").unwrap_or_default();
                    ErrorEntry {
                        number: u(e, "/error_number").unwrap_or(0),
                        lifetime_hours: u(e, "/lifetime_hours"),
                        lba: u(e, "/completion_registers/lba").or_else(|| lba_from_description(&description)),
                        description,
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    // Self-test log, newest first. ATA (extended or standard) or NVMe.
    let mut self_tests: Vec<SelfTest> = v
        .pointer("/ata_smart_self_test_log/extended/table")
        .or_else(|| v.pointer("/ata_smart_self_test_log/standard/table"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|e| SelfTest {
                    kind: s(e, "/type/string").unwrap_or_else(|| "Self-test".into()),
                    status: s(e, "/status/string").unwrap_or_default(),
                    passed: b(e, "/status/passed"),
                    lifetime_hours: u(e, "/lifetime_hours"),
                    lba_first_error: u(e, "/lba"),
                })
                .collect()
        })
        .unwrap_or_default();
    if self_tests.is_empty() {
        if let Some(arr) = v.pointer("/nvme_self_test_log/table").and_then(Value::as_array) {
            self_tests = arr
                .iter()
                .map(|e| {
                    let code = u(e, "/self_test_result/value");
                    SelfTest {
                        kind: s(e, "/self_test_code/string").unwrap_or_else(|| "Self-test".into()),
                        status: s(e, "/self_test_result/string").unwrap_or_default(),
                        passed: code.map(|c| c == 0),
                        lifetime_hours: u(e, "/power_on_hours"),
                        lba_first_error: u(e, "/lba"),
                    }
                })
                .collect();
        }
    }

    let temp_history = v
        .pointer("/ata_sct_temperature_history/table")
        .and_then(Value::as_array)
        .filter(|arr| !arr.is_empty())
        .map(|arr| TempHistory {
            interval_minutes: u(v, "/ata_sct_temperature_history/logging_interval_minutes").unwrap_or(1).max(1),
            values: arr.iter().map(Value::as_i64).collect(),
        });

    let nvme = v.pointer("/nvme_smart_health_information_log").map(|n| NvmeHealth {
        critical_warning: u(n, "/critical_warning").unwrap_or(0),
        available_spare: u(n, "/available_spare"),
        available_spare_threshold: u(n, "/available_spare_threshold"),
        percentage_used: u(n, "/percentage_used"),
        media_errors: u(n, "/media_errors").unwrap_or(0),
        error_log_entries: u(n, "/num_err_log_entries").unwrap_or(0),
        unsafe_shutdowns: u(n, "/unsafe_shutdowns"),
    });

    let block = u(v, "/logical_block_size").unwrap_or(512);
    const MIB: u64 = 1024 * 1024;
    const GIB: u64 = 1024 * MIB;
    let (bytes_written, bytes_read) = if nvme.is_some() {
        (
            u(v, "/nvme_smart_health_information_log/data_units_written").map(|x| x.saturating_mul(512_000)),
            u(v, "/nvme_smart_health_information_log/data_units_read").map(|x| x.saturating_mul(512_000)),
        )
    } else {
        (
            bytes_from_attribute(
                &attributes,
                &[("Total_LBAs_Written", block), ("Host_Writes_32MiB", 32 * MIB), ("Host_Writes_GiB", GIB), ("Lifetime_Writes_GiB", GIB), ("Total_Writes_GiB", GIB)],
            ),
            bytes_from_attribute(
                &attributes,
                &[("Total_LBAs_Read", block), ("Host_Reads_32MiB", 32 * MIB), ("Host_Reads_GiB", GIB), ("Lifetime_Reads_GiB", GIB), ("Total_Reads_GiB", GIB)],
            ),
        )
    };

    let model_family = s(v, "/model_family");
    let smr = model_family.as_deref().is_some_and(|f| f.contains("SMR"));

    let messages = v
        .pointer("/smartctl/messages")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(|m| s(m, "/string")).collect())
        .unwrap_or_default();

    SmartInfo {
        protocol,
        device_type: device_type.to_string(),
        device_name: device_name.to_string(),
        model_family,
        model_name: s(v, "/model_name"),
        serial: s(v, "/serial_number"),
        firmware: s(v, "/firmware_version"),
        capacity_bytes: u(v, "/user_capacity/bytes"),
        rotation_rate: u(v, "/rotation_rate"),
        form_factor: s(v, "/form_factor/name"),
        sata_version: s(v, "/sata_version/string"),
        link_speed: s(v, "/interface_speed/current/string"),
        link_speed_max: s(v, "/interface_speed/max/string"),
        trim: b(v, "/trim/supported"),
        smr,
        smart_passed: b(v, "/smart_status/passed"),
        power_on_hours: u(v, "/power_on_time/hours"),
        power_cycles: u(v, "/power_cycle_count"),
        temperature: i(v, "/temperature/current"),
        temp_lifetime_min: i(v, "/temperature/lifetime_min").or_else(|| i(v, "/ata_sct_status/temperature/lifetime_min")),
        temp_lifetime_max: i(v, "/temperature/lifetime_max").or_else(|| i(v, "/ata_sct_status/temperature/lifetime_max")),
        temp_limit: i(v, "/ata_sct_temperature_history/temperature/op_limit_max")
            .or_else(|| i(v, "/temperature/op_limit_max"))
            .filter(|t| *t > 0),
        temp_history,
        attributes,
        error_log_count,
        error_log,
        self_tests,
        self_test_remaining: u(v, "/ata_smart_data/self_test/status/remaining_percent"),
        self_test_minutes_short: u(v, "/ata_smart_data/self_test/polling_minutes/short"),
        self_test_minutes_extended: u(v, "/ata_smart_data/self_test/polling_minutes/extended"),
        nvme,
        bytes_written,
        bytes_read,
        messages,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_device_names_to_disk_numbers() {
        assert_eq!(device_index("/dev/sda"), Some(0));
        assert_eq!(device_index("/dev/sdb"), Some(1));
        assert_eq!(device_index("/dev/sdz"), Some(25));
        assert_eq!(device_index("/dev/sdaa"), Some(26));
        assert_eq!(device_index("/dev/pd3"), Some(3));
        assert_eq!(device_index("/dev/csmi0,1"), None);
    }

    #[test]
    fn reads_lba_from_error_description() {
        assert_eq!(lba_from_description("Error: UNC at LBA = 0x0001040c = 66572"), Some(66572));
        assert_eq!(lba_from_description("Error: ABRT"), None);
    }
}

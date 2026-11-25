//! Disk inventory from Windows: disk numbers, drive letters, bus type and, for USB drives,
//! which port the adapter is on (Hi-Speed "HSnn" = USB 2.0, SuperSpeed "SSnn" = USB 3).

use std::process::Stdio;
use std::time::Duration;

use base64::Engine;

use crate::model::{RawUsb, RawWinDisk, UsbInfo, UsbLink, WinDisk};

const INVENTORY_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$physical = @(Get-PhysicalDisk)
$out = @()
foreach ($d in @(Get-Disk)) {
  $pd = $physical | Where-Object { $_.DeviceId -eq [string]$d.Number } | Select-Object -First 1
  $vols = @()
  foreach ($p in @(Get-Partition -DiskNumber $d.Number | Where-Object { $_.DriveLetter })) {
    $v = Get-Volume -DriveLetter $p.DriveLetter
    $vols += [pscustomobject]@{
      letter = [string]$p.DriveLetter; label = $v.FileSystemLabel; fileSystem = $v.FileSystem
      sizeBytes = [int64]$v.Size; freeBytes = [int64]$v.SizeRemaining
    }
  }
  $usb = $null
  if ($d.Path) {
    $cur = (($d.Path -replace '^\\\\\?\\', '') -replace '#\{[^}]+\}$', '') -replace '#', '\'
    for ($i = 0; $i -lt 8 -and $cur; $i++) {
      $parent = (Get-PnpDeviceProperty -InstanceId $cur -KeyName DEVPKEY_Device_Parent).Data
      if (-not $parent) { break }
      if ($parent -like 'USB\VID_*') {
        $usb = [pscustomobject]@{
          instanceId = $parent
          locationPaths = (@((Get-PnpDeviceProperty -InstanceId $parent -KeyName DEVPKEY_Device_LocationPaths).Data) -join '|')
          service = (Get-PnpDeviceProperty -InstanceId $parent -KeyName DEVPKEY_Device_Service).Data
        }
        break
      }
      $cur = $parent
    }
  }
  $out += [pscustomobject]@{
    number = [int]$d.Number; friendlyName = $d.FriendlyName; busType = [string]$d.BusType
    mediaType = [string]$pd.MediaType; sizeBytes = [int64]$d.Size
    isSystem = [bool]$d.IsSystem; isBoot = [bool]$d.IsBoot; volumes = $vols; usb = $usb
  }
}
ConvertTo-Json -InputObject @($out) -Depth 5 -Compress
"#;

pub async fn inventory() -> Result<Vec<WinDisk>, String> {
    let utf16: Vec<u8> = INVENTORY_SCRIPT.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let child = cmd.spawn().map_err(|e| format!("Couldn't start PowerShell: {e}"))?;
    let out = tokio::time::timeout(Duration::from_secs(40), child.wait_with_output())
        .await
        .map_err(|_| "Windows didn't list the disks within 40 seconds.".to_string())?
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let json = text.trim().trim_start_matches('\u{feff}');
    if json.is_empty() {
        return Err("Windows returned no disk list.".into());
    }
    let raw: Vec<RawWinDisk> = serde_json::from_str(json).map_err(|e| format!("Unexpected disk list: {e}"))?;
    let mut disks: Vec<WinDisk> = raw.into_iter().map(to_win_disk).collect();
    disks.sort_by_key(|d| d.number);
    Ok(disks)
}

pub fn to_win_disk(r: RawWinDisk) -> WinDisk {
    WinDisk {
        number: r.number,
        friendly_name: r.friendly_name,
        bus_type: r.bus_type,
        media_type: r.media_type.filter(|m| !m.is_empty() && m != "Unspecified"),
        size_bytes: r.size_bytes,
        is_system: r.is_system,
        is_boot: r.is_boot,
        volumes: r.volumes.unwrap_or_default(),
        usb: r.usb.map(usb_info),
    }
}

/// Free bytes on a drive letter such as "D".
#[cfg(windows)]
pub fn free_space(letter: &str) -> Option<u64> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let root: Vec<u16> = format!("{letter}:\\").encode_utf16().chain(std::iter::once(0)).collect();
    let mut free_to_caller = 0u64;
    let ok = unsafe { GetDiskFreeSpaceExW(root.as_ptr(), &mut free_to_caller, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free_to_caller)
}

#[cfg(not(windows))]
pub fn free_space(_letter: &str) -> Option<u64> {
    None
}

/// A storage problem Windows logged: a reset of the disk's connection (event 129 from a
/// storage driver such as UASPStor) or a disk error (events 7, 11, 153 from "disk").
#[derive(Debug, Clone, PartialEq)]
pub struct StorageEvent {
    pub source: String,
    pub id: u32,
    pub time: String,
}

/// Storage problems logged since `since_ms`. Used as the speed test's watchdog.
pub async fn storage_events_since(since_ms: u64) -> Result<Vec<StorageEvent>, String> {
    let query = format!(
        "*[System[(EventID=129 or EventID=7 or EventID=11 or EventID=153) and TimeCreated[@SystemTime>='{}']]]",
        iso_utc(since_ms)
    );
    let mut cmd = tokio::process::Command::new("wevtutil.exe");
    cmd.args(["qe", "System", &format!("/q:{query}"), "/f:text", "/c:50"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let child = cmd.spawn().map_err(|e| format!("Couldn’t read the Windows event log: {e}"))?;
    let out = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .map_err(|_| "Reading the Windows event log timed out.".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(parse_storage_events(&String::from_utf8_lossy(&out.stdout)))
}

fn parse_storage_events(text: &str) -> Vec<StorageEvent> {
    let mut events = Vec::new();
    for block in text.split("Event[").skip(1) {
        let field = |name: &str| {
            block
                .lines()
                .find_map(|l| l.trim().strip_prefix(name).map(|v| v.trim().to_string()))
                .unwrap_or_default()
        };
        let source = field("Source:");
        let id: u32 = field("Event ID:").parse().unwrap_or(0);
        let src = source.to_ascii_lowercase();
        // Event 129 is also used by unrelated services (e.g. the time service), so only
        // storage drivers count; 7/11/153 only from the "disk" driver.
        let storage_reset = id == 129 && (src.contains("stor") || src.contains("nvme") || src.contains("disk"));
        let disk_error = src == "disk" && matches!(id, 7 | 11 | 153);
        if storage_reset || disk_error {
            events.push(StorageEvent { source, id, time: field("Date:") });
        }
    }
    events
}

/// Milliseconds since the Unix epoch -> "2026-11-25T07:35:00.000Z".
pub fn iso_utc(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, sod) = ((secs / 86_400) as i64, secs % 86_400);
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe as i64 + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", sod / 3600, (sod % 3600) / 60, sod % 60, ms % 1000)
}

pub fn usb_info(raw: RawUsb) -> UsbInfo {
    let id = raw.instance_id.to_ascii_uppercase();
    let field = |key: &str| -> Option<String> {
        let start = id.find(key)? + key.len();
        Some(id[start..].chars().take(4).collect())
    };
    let vendor_id = field("VID_");
    let product_id = field("PID_");
    let paths = raw.location_paths.unwrap_or_default().to_ascii_uppercase();
    let port = find_acpi_port(&paths);
    let link = match port.as_deref() {
        Some(p) if p.starts_with("SS") => UsbLink::Usb3,
        Some(p) if p.starts_with("HS") => UsbLink::Usb2,
        _ => UsbLink::Unknown,
    };
    let driver = raw.service.map(|s| match s.to_ascii_lowercase().as_str() {
        "uaspstor" => "UAS".to_string(),
        "usbstor" => "BOT".to_string(),
        _ => s,
    });
    let chip = vendor_id.as_deref().and_then(chip_vendor).map(str::to_string);
    UsbInfo { vendor_id, product_id, chip, link, port, driver }
}

/// Last "ACPI(SSnn)" or "ACPI(HSnn)" segment in the device's location paths.
fn find_acpi_port(paths: &str) -> Option<String> {
    let mut found = None;
    let mut rest = paths;
    while let Some(i) = rest.find("ACPI(") {
        let after = &rest[i + 5..];
        if let Some(end) = after.find(')') {
            let name = &after[..end];
            if (name.starts_with("SS") || name.starts_with("HS")) && name.len() <= 6 {
                found = Some(name.to_string());
            }
            rest = &after[end..];
        } else {
            break;
        }
    }
    found
}

fn chip_vendor(vid: &str) -> Option<&'static str> {
    Some(match vid {
        "152D" => "JMicron",
        "0BDA" => "Realtek",
        "174C" => "ASMedia",
        "2109" => "VIA Labs",
        "05E3" => "Genesys Logic",
        "067B" => "Prolific",
        "1F75" => "Innostor",
        "2537" => "Norelsys",
        "1058" => "Western Digital",
        "0BC2" => "Seagate",
        "04E8" => "Samsung",
        "0480" => "Toshiba",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_utc_times() {
        assert_eq!(iso_utc(1_795_592_100_000), "2026-11-25T07:35:00.000Z");
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(951_782_400_123), "2000-02-29T00:00:00.123Z");
    }

    #[test]
    fn picks_out_storage_events_only() {
        let text = "Event[0]:\r\n  Log Name: System\r\n  Source: UASPStor\r\n  Date: 2026-11-25T10:41:11.000\r\n  Event ID: 129\r\n  Description: Reset to device, \\Device\\RaidPort4, was issued.\r\n\r\n\
Event[1]:\r\n  Log Name: System\r\n  Source: Microsoft-Windows-Time-Service\r\n  Date: 2026-11-25T10:42:00.000\r\n  Event ID: 129\r\n\r\n\
Event[2]:\r\n  Log Name: System\r\n  Source: disk\r\n  Date: 2026-11-25T10:43:00.000\r\n  Event ID: 153\r\n";
        let events = parse_storage_events(text);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].source, "UASPStor");
        assert_eq!(events[0].id, 129);
        assert_eq!(events[1].source, "disk");
        assert_eq!(events[1].id, 153);
    }

    #[test]
    fn detects_usb2_and_usb3_ports() {
        let usb3 = usb_info(RawUsb {
            instance_id: r"USB\VID_0BDA&PID_9201\MSFT30012345679457".into(),
            location_paths: Some("PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(13)|ACPI(_SB_)#ACPI(PC00)#ACPI(XHCI)#ACPI(RHUB)#ACPI(SS01)".into()),
            service: Some("UASPStor".into()),
        });
        assert_eq!(usb3.link, UsbLink::Usb3);
        assert_eq!(usb3.port.as_deref(), Some("SS01"));
        assert_eq!(usb3.chip.as_deref(), Some("Realtek"));
        assert_eq!(usb3.driver.as_deref(), Some("UAS"));

        let usb2 = usb_info(RawUsb {
            instance_id: r"USB\VID_152D&PID_0578\MSFT30FF202406110168".into(),
            location_paths: Some("PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(1)|ACPI(_SB_)#ACPI(PC00)#ACPI(XHCI)#ACPI(RHUB)#ACPI(HS01)".into()),
            service: Some("USBSTOR".into()),
        });
        assert_eq!(usb2.link, UsbLink::Usb2);
        assert_eq!(usb2.chip.as_deref(), Some("JMicron"));
        assert_eq!(usb2.driver.as_deref(), Some("BOT"));
    }
}

//! Turns raw S.M.A.R.T. data into a score, a status and plain-English findings.
//!
//! Score: starts at 100 and loses points per sign of wear or failure (see `deductions`).
//! Status: like CrystalDiskInfo, any bad/pending/unreadable sector, logged error or failed
//! self-test makes it "Caution" whatever the percentage.

use crate::history::Snapshot;
use crate::model::*;

/// `previous` is the drive's last saved check, used to spot anything that got worse.
pub fn assess(s: &SmartInfo, kind: DriveKind, usb: Option<&UsbInfo>, previous: Option<&Snapshot>) -> Health {
    match kind {
        DriveKind::Nvme => assess_nvme(s, usb, previous),
        _ => assess_ata(s, kind, usb, previous),
    }
}

/// Counters that only ever go up on a failing drive.
fn change_findings(f: &mut Vec<Finding>, previous: Option<&Snapshot>, now: &[(&str, u64, fn(&Snapshot) -> u64)]) {
    let Some(prev) = previous else { return };
    let worse: Vec<String> = now
        .iter()
        .filter(|(_, value, before)| *value > before(prev))
        .map(|(label, value, before)| format!("{label} {} → {}", fmt_num(before(prev)), fmt_num(*value)))
        .collect();
    if !worse.is_empty() {
        f.push(finding(
            Level::Warning,
            "Worse since the last check",
            format!("{}. A count that keeps growing means the drive is developing problems.", worse.join("; ")),
            Some("Back up anything important now, and check the drive again in a few days."),
        ));
    }
}

// ---------------------------------------------------------------- helpers

pub fn fmt_num(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn plural(n: u64, word: &str) -> String {
    if n == 1 { format!("1 {word}") } else { format!("{} {word}s", fmt_num(n)) }
}

fn level_for(v: u64, warn: u64, bad: u64) -> Level {
    if v >= bad {
        Level::Critical
    } else if v >= warn {
        Level::Warning
    } else {
        Level::Good
    }
}

fn deduct(list: &mut Vec<Deduction>, factor: &str, rule: &str, value: String, count: u64, per: u64, max: u64) {
    let points = count.saturating_mul(per).min(max) as u32;
    list.push(Deduction { factor: factor.into(), rule: rule.into(), value, points });
}

fn finding(level: Level, title: impl Into<String>, detail: impl Into<String>, action: Option<&str>) -> Finding {
    Finding { level, title: title.into(), detail: detail.into(), action: action.map(str::to_string) }
}

fn indicator(label: &str, value: impl Into<String>, level: Level, help: &str) -> Indicator {
    Indicator { label: label.into(), value: value.into(), level, help: help.into() }
}

fn push_attr(ind: &mut Vec<Indicator>, s: &SmartInfo, id: u64, label: &str, warn: u64, bad: u64, help: &str) {
    if let Some(a) = s.attributes.iter().find(|a| a.id == id) {
        ind.push(indicator(label, fmt_num(a.raw), level_for(a.raw, warn, bad), help));
    }
}

fn test_failed(t: &SelfTest) -> bool {
    let st = t.status.to_ascii_lowercase();
    t.passed == Some(false) && !st.contains("abort") && !st.contains("interrupt")
}

/// "2 of 2 passed", "1 of 2 passed · 1 aborted", "1 aborted" (none completed).
fn self_test_indicator(tests: &[SelfTest]) -> Indicator {
    let passed = tests.iter().filter(|t| t.passed == Some(true)).count();
    let failed = tests.iter().filter(|t| test_failed(t)).count();
    let other = tests.len() - passed - failed;
    let last_failed = tests.first().is_some_and(test_failed);
    let completed = passed + failed;
    let value = match (tests.is_empty(), completed, other) {
        (true, _, _) => "None run".to_string(),
        (false, 0, o) => format!("{o} aborted"),
        (false, c, 0) => format!("{passed} of {c} passed"),
        (false, c, o) => format!("{passed} of {c} passed · {o} aborted"),
    };
    let level = if last_failed {
        Level::Critical
    } else if failed > 0 {
        Level::Warning
    } else if completed == 0 {
        Level::Info
    } else {
        Level::Good
    };
    indicator("Self-tests", value, level, "Built-in diagnostics run by the drive. Aborted tests count as neither passed nor failed.")
}

fn temp_limit(s: &SmartInfo, kind: DriveKind) -> i64 {
    s.temp_limit.unwrap_or(if kind == DriveKind::Hdd { 60 } else { 70 })
}

fn is_seagate(s: &SmartInfo) -> bool {
    let fam = s.model_family.as_deref().unwrap_or("");
    let model = s.model_name.as_deref().unwrap_or("");
    fam.contains("Seagate")
        || model.contains("Seagate")
        || (model.starts_with("ST") && model.chars().nth(2).is_some_and(|c| c.is_ascii_digit()))
}

/// Remaining life (%) of a SATA SSD from the usual vendor wear attributes.
fn ssd_life_left(s: &SmartInfo) -> Option<u64> {
    const NAMES: [&str; 6] = [
        "Percent_Lifetime_Remain",
        "SSD_Life_Left",
        "Remaining_Lifetime_Perc",
        "Percent_Life_Remaining",
        "Media_Wearout_Indicator",
        "Wear_Leveling_Count",
    ];
    NAMES.iter().find_map(|n| {
        s.attributes
            .iter()
            .find(|a| a.name.eq_ignore_ascii_case(n))
            .map(|a| a.value.min(100))
    })
}

fn status_for(score: u8, passed: bool, caution: bool) -> HealthStatus {
    if !passed {
        HealthStatus::Failing
    } else if score < 40 {
        HealthStatus::Poor
    } else if caution {
        HealthStatus::Caution
    } else if score >= 90 {
        HealthStatus::Excellent
    } else if score >= 70 {
        HealthStatus::Good
    } else {
        HealthStatus::Fair
    }
}

fn temperature_findings(f: &mut Vec<Finding>, temp: Option<i64>, limit: i64) {
    if let Some(t) = temp {
        if t > limit {
            f.push(finding(
                Level::Critical,
                "Running too hot",
                format!("{t} °C, above the recommended maximum of {limit} °C. Heat shortens a drive’s life."),
                Some("Give the drive more airflow, or move it away from heat sources."),
            ));
        } else if t >= limit - 5 {
            f.push(finding(
                Level::Warning,
                "Running warm",
                format!("{t} °C, close to the recommended maximum of {limit} °C."),
                Some("Give the drive more airflow."),
            ));
        }
    }
}

fn usb_findings(f: &mut Vec<Finding>, usb: Option<&UsbInfo>) {
    if let Some(u) = usb {
        if u.link == UsbLink::Usb2 {
            let port = u.port.as_deref().map(|p| format!(" ({p})")).unwrap_or_default();
            f.push(finding(
                Level::Warning,
                "Connected at USB 2.0 speed",
                format!(
                    "Windows shows this drive on a USB 2.0 (Hi-Speed) port{port}, which limits it to about 40 MB/s. This isn’t a fault in the drive."
                ),
                Some("Plug it straight into a USB 3 port (often blue or marked SS) using a USB 3 cable."),
            ));
        }
    }
}

fn finish(mut f: Vec<Finding>, good_detail: String) -> (Vec<Finding>, String) {
    f.sort_by(|a, b| b.level.cmp(&a.level));
    let warnings: Vec<&Finding> = f.iter().filter(|x| x.level >= Level::Warning).collect();
    let summary = match warnings.len() {
        0 => "No signs of wear or failure.".to_string(),
        1 => format!("{}. Everything else looks normal.", warnings[0].title),
        n => format!("{}, plus {}.", warnings[0].title, plural(n as u64 - 1, "more issue")),
    };
    if warnings.is_empty() {
        f.insert(0, finding(Level::Good, "No signs of wear or failure", good_detail, None));
    }
    (f, summary)
}

// ---------------------------------------------------------------- SATA / ATA

fn assess_ata(s: &SmartInfo, kind: DriveKind, usb: Option<&UsbInfo>, previous: Option<&Snapshot>) -> Health {
    let attr = |id: u64| s.attributes.iter().find(|a| a.id == id);
    let raw = |id: u64| attr(id).map(|a| a.raw).unwrap_or(0);
    let is_hdd = kind == DriveKind::Hdd;

    let realloc = raw(5);
    let pending = raw(197);
    let offline = raw(198);
    let spin = raw(10);
    let crc = raw(199);
    let failing: Vec<&AtaAttribute> = s.attributes.iter().filter(|a| a.thresh > 0 && a.value <= a.thresh).collect();
    let last_failed = s.self_tests.first().is_some_and(test_failed);
    let limit = temp_limit(s, kind);
    let life_left = if kind == DriveKind::Ssd { ssd_life_left(s) } else { None };
    let passed = s.smart_passed != Some(false);

    // ---- score
    let mut d = Vec::new();
    if let Some(left) = life_left {
        deduct(&mut d, "Wear (life used)", "−1 per % used", format!("{}% used", 100 - left), 100 - left, 1, 100);
    }
    deduct(&mut d, "Reallocated (replaced) sectors", "−1 per sector, up to −40", fmt_num(realloc), realloc, 1, 40);
    deduct(&mut d, "Current pending sectors", "−2 per sector, up to −40", fmt_num(pending), pending, 2, 40);
    deduct(&mut d, "Offline uncorrectable sectors", "−2 per sector, up to −40", fmt_num(offline), offline, 2, 40);
    if is_hdd {
        deduct(&mut d, "Spin retries", "−5 each, up to −20", fmt_num(spin), spin, 5, 20);
    }
    deduct(&mut d, "Errors in the drive’s error log", "−2 each, up to −20", fmt_num(s.error_log_count), s.error_log_count, 2, 20);
    deduct(&mut d, "Most recent self-test failed", "−30", if last_failed { "Yes" } else { "No" }.into(), last_failed as u64, 30, 30);
    let hot = s.temperature.is_some_and(|t| t > limit);
    let temp_text = s.temperature.map(|t| format!("{t} °C")).unwrap_or_else(|| "Unknown".into());
    deduct(&mut d, &format!("Temperature above {limit} °C"), "−10", temp_text, hot as u64, 10, 10);
    deduct(&mut d, "Attributes past failure threshold", "−60 if any", fmt_num(failing.len() as u64), failing.len() as u64, 60, 60);
    let total: u32 = d.iter().map(|x| x.points).sum();
    let mut score = 100u32.saturating_sub(total) as u8;
    if !passed {
        score = score.min(10);
    }
    let caution = realloc + pending + offline > 0 || s.error_log_count > 0 || last_failed || !failing.is_empty();
    let status = status_for(score, passed, caution);

    // ---- findings
    let mut f = Vec::new();
    if !passed {
        f.push(finding(
            Level::Critical,
            "The drive reports that it is failing",
            "Its own S.M.A.R.T. self-assessment failed.",
            Some("Copy anything important off the drive now and replace it."),
        ));
    }
    if !failing.is_empty() {
        let names: Vec<String> = failing.iter().map(|a| a.name.replace('_', " ")).collect();
        f.push(finding(
            Level::Critical,
            format!("{} past the failure threshold", plural(failing.len() as u64, "attribute")),
            format!("{} reached the level the manufacturer treats as failing.", names.join(", ")),
            Some("Copy anything important off the drive and replace it."),
        ));
    }
    if last_failed {
        let t = &s.self_tests[0];
        let at = t.lba_first_error.map(|l| format!(" First error at sector {}.", fmt_num(l))).unwrap_or_default();
        f.push(finding(
            Level::Critical,
            "The last self-test failed",
            format!("{}: “{}”.{at}", t.kind, t.status),
            Some("Copy anything important off the drive."),
        ));
    }
    if pending > 0 {
        let mut lbas: Vec<u64> = s.error_log.iter().filter_map(|e| e.lba).collect();
        lbas.sort_unstable();
        lbas.dedup();
        let them = if pending == 1 { "it" } else { "them" };
        let mut detail = format!(
            "The drive will re-test {them} the next time data is written there, then keep {them} if it was only a weak write, or swap in a spare if the surface is damaged."
        );
        if !lbas.is_empty() && s.error_log_count > 0 {
            let list: Vec<String> = lbas.iter().take(3).map(|l| fmt_num(*l)).collect();
            let word = if lbas.len() == 1 { "sector" } else { "sectors" };
            detail.push_str(&format!(
                " The drive logged {} on {word} {}.",
                plural(s.error_log_count, "read error"),
                list.join(", ")
            ));
        }
        if realloc == 0 {
            detail.push_str(" Nothing has been replaced yet.");
        }
        f.push(finding(
            if pending >= 5 { Level::Critical } else { Level::Warning },
            format!("{} can’t be read reliably", plural(pending, "sector")),
            detail,
            Some("Keep a backup of anything important, then run the drive’s extended self-test."),
        ));
    }
    if realloc > 0 {
        f.push(finding(
            if realloc >= 10 { Level::Critical } else { Level::Warning },
            format!("{} replaced with spares", plural(realloc, "sector")),
            "Damaged spots have been swapped for spare sectors. A few on their own aren’t dangerous, but a growing count is a sign of wear.",
            Some("Check again in a few weeks to see whether the number is growing."),
        ));
    }
    if offline > 0 {
        f.push(finding(
            if offline >= 5 { Level::Critical } else { Level::Warning },
            format!("{} unreadable in the drive’s own scan", plural(offline, "sector")),
            "The drive couldn’t read these sectors during its background check.",
            Some("Keep a backup of anything important, then run the extended self-test."),
        ));
    }
    change_findings(
        &mut f,
        previous,
        &[
            ("Reallocated sectors", realloc, |p| p.reallocated),
            ("Pending sectors", pending, |p| p.pending),
            ("Uncorrectable sectors", offline, |p| p.uncorrectable),
            ("Errors logged", s.error_log_count, |p| p.error_log),
        ],
    );
    if let Some(prev) = previous {
        if prev.pending > 0 && pending == 0 && realloc == prev.reallocated {
            f.push(finding(
                Level::Info,
                "The weak sector was cleared",
                "The drive re-tested the sector it couldn’t read before and kept it, so it was a weak write rather than damage.",
                None,
            ));
        }
    }
    if s.error_log_count > 0 && pending == 0 {
        let last = s.error_log.first();
        let when = last.and_then(|e| e.lifetime_hours).map(|h| format!(" The latest was at drive hour {}.", fmt_num(h))).unwrap_or_default();
        f.push(finding(
            Level::Warning,
            format!("{} in the drive’s error log", plural(s.error_log_count, "error")),
            format!("Commands that failed are recorded by the drive itself.{when}"),
            Some("Run the extended self-test to check the whole disk."),
        ));
    }
    temperature_findings(&mut f, s.temperature, limit);
    if let Some(left) = life_left {
        if left <= 10 {
            f.push(finding(Level::Critical, "Almost worn out", format!("About {left}% of its rated life is left."), Some("Plan to replace this SSD soon.")));
        } else if left <= 30 {
            f.push(finding(Level::Warning, "Well worn", format!("About {left}% of its rated life is left."), Some("Keep backups and plan a replacement.")));
        }
    }
    if crc > 0 {
        f.push(finding(
            if crc >= 50 { Level::Warning } else { Level::Info },
            format!("{} between drive and computer", plural(crc, "transfer error")),
            "Data was damaged in transit. This usually points to the cable or USB adapter, not the disk itself.",
            Some("Try another cable or adapter."),
        ));
    }
    usb_findings(&mut f, usb);
    if let Some(rem) = s.self_test_remaining.filter(|r| *r > 0) {
        f.push(finding(Level::Info, "A self-test is running", format!("{rem}% remaining."), None));
    }
    if is_hdd {
        let retracts = raw(192);
        if let Some(hours) = s.power_on_hours {
            if retracts >= 5 && retracts * 10 >= hours {
                f.push(finding(
                    Level::Info,
                    format!("{} sudden power losses", fmt_num(retracts)),
                    "Each time the drive loses power while running, its heads park in an emergency. Unplugging without “Safely remove” is the usual cause, and it can leave weak sectors behind.",
                    Some("Use “Safely remove” before unplugging."),
                ));
            }
        }
    }
    if s.smr {
        f.push(finding(
            Level::Info,
            "Shingled (SMR) recording",
            "A dense recording method that’s fine for backups and storage. Long continuous copies can slow down partway through.",
            None,
        ));
    }
    let good_detail = match life_left {
        Some(left) => format!("About {left}% of its rated life is left, no sectors have been replaced and the drive has logged no errors."),
        None => {
            let tests = if s.self_tests.iter().any(|t| t.passed == Some(true)) { " Its self-tests passed." } else { "" };
            format!("Every critical counter is at zero and the drive has logged no errors.{tests}")
        }
    };
    let (findings, summary) = finish(f, good_detail);

    // ---- indicators
    let mut ind = Vec::new();
    ind.push(indicator(
        "S.M.A.R.T. verdict",
        match s.smart_passed { Some(true) => "PASSED", Some(false) => "FAILED", None => "Unknown" },
        match s.smart_passed { Some(false) => Level::Critical, None => Level::Info, _ => Level::Good },
        "The drive’s own overall pass/fail check.",
    ));
    if let Some(left) = life_left {
        let lv = if left <= 10 { Level::Critical } else if left <= 30 { Level::Warning } else { Level::Good };
        ind.push(indicator("Life remaining", format!("{left}%"), lv, "Estimated from the drive’s wear counter."));
    }
    push_attr(&mut ind, s, 5, "Reallocated sectors", 1, 10, "Damaged spots already replaced with spares. The most important wear sign.");
    push_attr(&mut ind, s, 197, "Pending sectors", 1, 5, "Sectors that read unreliably and are waiting to be re-tested.");
    push_attr(&mut ind, s, 198, "Uncorrectable sectors", 1, 5, "Sectors the drive couldn’t read during its own scan.");
    ind.push(indicator("Drive error log", fmt_num(s.error_log_count), level_for(s.error_log_count, 1, 10), "Read/write commands that failed."));
    if is_hdd && !is_seagate(s) {
        push_attr(&mut ind, s, 1, "Read error rate", 1, 100, "Errors while reading data from the platters.");
        push_attr(&mut ind, s, 7, "Seek error rate", 1, 100, "Errors moving the read/write heads into position.");
    }
    if is_hdd {
        push_attr(&mut ind, s, 10, "Spin retries", 1, 5, "Times the motor needed a second try to reach full speed.");
    }
    push_attr(&mut ind, s, 199, "Interface CRC errors", 1, 50, "Data damaged between drive and computer. Usually the cable or adapter.");
    ind.push(self_test_indicator(&s.self_tests));

    Health { score, status, summary, findings, indicators: ind, deductions: d }
}

// ---------------------------------------------------------------- NVMe

fn assess_nvme(s: &SmartInfo, usb: Option<&UsbInfo>, previous: Option<&Snapshot>) -> Health {
    let n = s.nvme.clone().unwrap_or_default();
    let used = n.percentage_used.unwrap_or(0);
    let spare_low = matches!((n.available_spare, n.available_spare_threshold), (Some(a), Some(t)) if a < t);
    let cw = n.critical_warning;
    let limit = temp_limit(s, DriveKind::Nvme);
    let last_failed = s.self_tests.first().is_some_and(test_failed);
    let passed = s.smart_passed != Some(false) && (cw & 0x0C) == 0;

    let mut d = Vec::new();
    deduct(&mut d, "Wear (life used)", "−1 per % used", format!("{used}%"), used, 1, 100);
    deduct(&mut d, "Media and data integrity errors", "−5 each, up to −40", fmt_num(n.media_errors), n.media_errors, 5, 40);
    deduct(&mut d, "Spare blocks below threshold", "−40", if spare_low { "Yes" } else { "No" }.into(), spare_low as u64, 40, 40);
    deduct(&mut d, "Critical warning from the drive", "−30", if cw != 0 { format!("0x{cw:02X}") } else { "None".into() }, (cw != 0) as u64, 30, 30);
    deduct(&mut d, "Most recent self-test failed", "−30", if last_failed { "Yes" } else { "No" }.into(), last_failed as u64, 30, 30);
    let hot = s.temperature.is_some_and(|t| t > limit);
    let temp_text = s.temperature.map(|t| format!("{t} °C")).unwrap_or_else(|| "Unknown".into());
    deduct(&mut d, &format!("Temperature above {limit} °C"), "−10", temp_text, hot as u64, 10, 10);
    let total: u32 = d.iter().map(|x| x.points).sum();
    let mut score = 100u32.saturating_sub(total) as u8;
    if !passed {
        score = score.min(10);
    }
    let caution = n.media_errors > 0 || cw != 0 || spare_low || last_failed;
    let status = status_for(score, passed, caution);

    let mut f = Vec::new();
    if s.smart_passed == Some(false) {
        f.push(finding(Level::Critical, "The drive reports that it is failing", "Its own health check failed.", Some("Copy anything important off the drive now and replace it.")));
    }
    if cw & 0x08 != 0 {
        f.push(finding(Level::Critical, "The drive has switched to read-only", "It has protected itself by refusing new writes.", Some("Copy your data off and replace the drive.")));
    }
    if cw & 0x04 != 0 {
        f.push(finding(Level::Critical, "Reliability degraded", "The drive reports internal errors that affect reliability.", Some("Copy anything important off the drive and replace it.")));
    }
    if cw & 0x01 != 0 || spare_low {
        f.push(finding(Level::Critical, "Spare blocks running out", "The drive has almost used up the reserve it uses to replace worn cells.", Some("Plan to replace this SSD soon.")));
    }
    if cw & 0x10 != 0 {
        f.push(finding(Level::Warning, "Backup power problem", "The drive reports that its power-loss protection failed.", None));
    }
    change_findings(&mut f, previous, &[("Media errors", n.media_errors, |p| p.media_errors)]);
    if n.media_errors > 0 {
        f.push(finding(
            if n.media_errors >= 10 { Level::Critical } else { Level::Warning },
            format!("{} recorded", plural(n.media_errors, "media error")),
            "The drive found data it couldn’t read back correctly.",
            Some("Keep a backup of anything important."),
        ));
    }
    if used >= 90 {
        f.push(finding(Level::Critical, "Almost worn out", format!("{used}% of its rated write life is used."), Some("Plan to replace this SSD soon.")));
    } else if used >= 70 {
        f.push(finding(Level::Warning, "Well worn", format!("{used}% of its rated write life is used."), Some("Keep backups and plan a replacement.")));
    }
    if cw & 0x02 != 0 {
        f.push(finding(Level::Warning, "Temperature warning from the drive", "The drive has reported running outside its safe temperature range.", Some("Check the cooling around the drive.")));
    }
    temperature_findings(&mut f, s.temperature, limit);
    usb_findings(&mut f, usb);
    let (findings, summary) = finish(
        f,
        format!("{used}% of its rated write life is used, there are no media errors and the drive reports no warnings."),
    );

    let mut ind = Vec::new();
    ind.push(indicator(
        "S.M.A.R.T. verdict",
        if passed { "PASSED" } else { "FAILED" },
        if passed { Level::Good } else { Level::Critical },
        "The drive’s own overall health check.",
    ));
    ind.push(indicator(
        "Life used",
        format!("{used}%"),
        if used >= 90 { Level::Critical } else if used >= 70 { Level::Warning } else { Level::Good },
        "Share of the drive’s rated write endurance already used.",
    ));
    if let Some(a) = n.available_spare {
        let t = n.available_spare_threshold.map(|t| format!(" (min {t}%)")).unwrap_or_default();
        ind.push(indicator("Available spare", format!("{a}%{t}"), if spare_low { Level::Critical } else { Level::Good }, "Reserve blocks left for replacing worn cells."));
    }
    ind.push(indicator("Media errors", fmt_num(n.media_errors), level_for(n.media_errors, 1, 10), "Data the drive couldn’t read back correctly."));
    ind.push(indicator(
        "Critical warnings",
        if cw == 0 { "None".to_string() } else { format!("0x{cw:02X}") },
        if cw == 0 { Level::Good } else { Level::Critical },
        "Warning flags raised by the drive itself.",
    ));
    ind.push(indicator("Error log entries", fmt_num(n.error_log_entries), Level::Info, "Command errors logged by the controller. Often harmless."));
    if let Some(us) = n.unsafe_shutdowns {
        ind.push(indicator("Unsafe shutdowns", fmt_num(us), Level::Info, "Times power was lost without a clean shutdown."));
    }
    if !s.self_tests.is_empty() {
        ind.push(self_test_indicator(&s.self_tests));
    }

    Health { score, status, summary, findings, indicators: ind, deductions: d }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_numbers() {
        assert_eq!(fmt_num(0), "0");
        assert_eq!(fmt_num(66572), "66,572");
        assert_eq!(fmt_num(17708529), "17,708,529");
        assert_eq!(plural(1, "sector"), "1 sector");
        assert_eq!(plural(2, "sector"), "2 sectors");
    }
}

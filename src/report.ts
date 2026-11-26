// Builds the exported report (a self-contained, print-ready A4 HTML page; the desktop app turns
// it into PDF) and the plain-text summary for pasting into tickets.
import type { DriveHistory, DriveReport, Level, SpeedRun } from "./types";
import type { Brand } from "./brand";
import { STATUS, errorText, fmtBytes, fmtDateTime, fmtHours, fmtNum, tempHistoryHours, usedTempHistory } from "./format";

export interface ReportOptions {
  preparedBy: string;
  customer: string;
  notes: string;
  includeSpeed: boolean;
  includeHistory: boolean;
}

export interface ReportInput {
  drive: DriveReport;
  history: DriveHistory | null;
  options: ReportOptions;
  brand: Brand;
  /** The brand logo as SVG text, embedded so the file works anywhere. */
  logoSvg: string | null;
  appVersion: string;
  smartctlVersion: string | null;
}

const esc = (s: string | number | null | undefined) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const COLORS: Record<Level, string> = { good: "#0ca30c", warning: "#fab219", critical: "#d03b3b", info: "#6e6d68" };

function icon(level: Level, size = 14): string {
  const c = COLORS[level];
  const s = `width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true"`;
  if (level === "good")
    return `<svg ${s}><circle cx="8" cy="8" r="7.5" fill="${c}"/><path d="M4.7 8.3l2.1 2.1 4.5-4.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (level === "warning")
    return `<svg ${s}><path d="M8 1.2 15.2 14H.8z" fill="${c}"/><path d="M8 5.8v3.8" stroke="#0b0b0b" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.7" r=".95" fill="#0b0b0b"/></svg>`;
  if (level === "critical")
    return `<svg ${s}><circle cx="8" cy="8" r="7.5" fill="${c}"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  return `<svg ${s}><circle cx="8" cy="8" r="7.5" fill="${c}"/><path d="M8 7.2v4" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="4.8" r="1" fill="#fff"/></svg>`;
}

/** Static temperature chart for print. */
function tempChart(values: (number | null)[], intervalMin: number, endMs: number): string {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) return "";
  const W = 640, H = 150, l = 30, r = 44, t = 8, b = 20;
  const iw = W - l - r, ih = H - t - b;
  const lo = Math.floor((Math.min(...nums) - 3) / 5) * 5;
  let hi = Math.ceil((Math.max(...nums) + 3) / 5) * 5;
  if (hi - lo < 15) hi = lo + 15;
  const n = values.length;
  const x = (i: number) => l + (i / (n - 1)) * iw;
  const y = (v: number) => t + (1 - (v - lo) / (hi - lo)) * ih;
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) return void (pen = false);
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  let s = "";
  for (let v = lo; v <= hi; v += 5) {
    s += `<line x1="${l}" x2="${l + iw}" y1="${y(v)}" y2="${y(v)}" stroke="${v === lo ? "#c3c2b7" : "#e7e6e1"}" stroke-width="1"/>`;
    s += `<text x="${l - 5}" y="${y(v)}" dy="0.32em" text-anchor="end" font-size="9" fill="#898781">${v}°</text>`;
  }
  const lastIdx = values.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).pop()!;
  const startMs = endMs - (n - 1) * intervalMin * 60_000;
  s += `<text x="${l}" y="${H - 4}" font-size="9" fill="#898781">${esc(fmtDateTime(startMs))}</text>`;
  s += `<text x="${l + iw}" y="${H - 4}" font-size="9" fill="#898781" text-anchor="end">${esc(fmtDateTime(endMs))}</text>`;
  s += `<path d="${d}" fill="none" stroke="#2a78d6" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`;
  // Single readings between gaps (common on drives that are often unplugged) as small dots.
  values.forEach((v, i) => {
    if (v != null && values[i - 1] == null && values[i + 1] == null) s += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.8" fill="#2a78d6"/>`;
  });
  s += `<circle cx="${x(lastIdx)}" cy="${y(values[lastIdx]!)}" r="3" fill="#2a78d6"/>`;
  s += `<text x="${x(lastIdx) + 6}" y="${y(values[lastIdx]!)}" dy="0.32em" font-size="10" font-weight="600" fill="#0b0b0b">${values[lastIdx]} °C</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Temperature history">${s}</svg>`;
}

function keyNumbers(d: DriveReport): [string, string, string][] {
  const s = d.smart!;
  const limit = s.tempLimit ?? (d.kind === "hdd" ? 60 : 70);
  const rows: [string, string, string][] = [
    ["Temperature", s.temperature != null ? `${s.temperature} °C` : "—", s.tempLifetimeMax != null ? `lifetime ${s.tempLifetimeMin}–${s.tempLifetimeMax} °C · limit ${limit} °C` : `limit ${limit} °C`],
  ];
  if (s.nvme) {
    rows.push(["Life used", `${s.nvme.percentageUsed ?? "—"}%`, `${s.nvme.availableSpare ?? "—"}% spare blocks left`]);
    rows.push(["Data written", fmtBytes(s.bytesWritten), `${fmtBytes(s.bytesRead)} read`]);
  } else {
    rows.push(["Power-on time", fmtHours(s.powerOnHours), s.powerCycles != null ? `${fmtNum(s.powerCycles)} power cycles` : ""]);
    rows.push(["Errors logged", fmtNum(s.errorLogCount), s.errorLogCount ? "in the drive’s own log" : "no read or write failures"]);
  }
  const usb = d.windows.usb;
  rows.push(
    usb
      ? ["Connection", usb.link === "usb3" ? "USB 3" : usb.link === "usb2" ? "USB 2.0" : "USB", [usb.chip && `${usb.chip} adapter`, usb.port, usb.driver].filter(Boolean).join(" · ")]
      : ["Connection", d.kind === "nvme" ? "NVMe" : d.windows.busType ?? "Internal", s.linkSpeed ? `internal · ${s.linkSpeed}` : "internal"],
  );
  return rows;
}

function speedTable(run: SpeedRun): string {
  const rows = [
    ["Sequential 1 MB, queue 8", "seq1m_q8_read", "seq1m_q8_write"],
    ["Sequential 1 MB, queue 1", "seq1m_q1_read", "seq1m_q1_write"],
    ["Random 4 KB, queue 32", "rnd4k_q32_read", "rnd4k_q32_write"],
    ["Random 4 KB, queue 1", "rnd4k_q1_read", "rnd4k_q1_write"],
  ];
  const cell = (id: string) => {
    const m = run.results.find((r) => r.id === id);
    if (!m) return `<td class="num">—</td>`;
    const v = m.mbPerS >= 100 ? m.mbPerS.toFixed(0) : m.mbPerS >= 10 ? m.mbPerS.toFixed(1) : m.mbPerS.toFixed(2);
    return `<td class="num"><b>${v}</b> MB/s${id.startsWith("rnd") ? `<div class="sub">${fmtNum(Math.round(m.iops))} IOPS</div>` : ""}</td>`;
  };
  const link = run.link === "usb3" ? "USB 3" : run.link === "usb2" ? "USB 2.0" : "internal";
  return `
    <p class="sub">Tested ${esc(fmtDateTime(run.atMs))} over ${esc(link)}, with a temporary 1 GB file on ${esc(run.volume)}: (deleted afterwards). Windows’ cache bypassed, as in CrystalDiskMark.</p>
    ${run.stopped ? `<p class="warn">${icon("warning")} ${esc(run.stopped)}</p>` : ""}
    <table><thead><tr><th>Test</th><th class="num">Read</th><th class="num">Write</th></tr></thead>
    <tbody>${rows.map(([label, r, w]) => `<tr><td>${esc(label)}</td>${cell(r)}${cell(w)}</tr>`).join("")}</tbody></table>`;
}

export function buildReportHtml(input: ReportInput): string {
  const { drive: d, history, options: o, brand, logoSvg } = input;
  const s = d.smart;
  const h = d.health;
  const st = h ? STATUS[h.status] : null;
  const org = brand.companyName || brand.appName;
  const logo = logoSvg ? `<img class="logo" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(logoSvg)}" alt="">` : "";
  const speed = o.includeSpeed ? history?.speedRuns.filter((r) => r.results.length > 0).slice(-1)[0] : undefined;
  const snaps = o.includeHistory ? (history?.snapshots ?? []).slice(-10).reverse() : [];
  const temp = s?.tempHistory ? usedTempHistory(s.tempHistory) : null;
  const identity = [s?.modelName ?? d.windows.friendlyName, s?.serial && `SN ${s.serial}`, d.capacityLabel, d.windows.volumes.map((v) => `${v.letter}:`).join(" ")]
    .filter(Boolean)
    .join(" · ");
  const contact = [brand.support.phone, brand.support.email, brand.support.website].filter(Boolean).join(" · ");

  const section = (title: string, body: string) => (body ? `<section><h2>${esc(title)}</h2>${body}</section>` : "");

  const verdict = h
    ? `<div class="verdict ${st!.level}">
        <div class="score"><span class="num-big">${h.score}<small>%</small></span><span class="status">${icon(st!.level, 16)} ${esc(st!.label)}</span></div>
        <div class="verdict-text"><p class="summary">${esc(h.summary)}</p>
          <div class="keys">${keyNumbers(d)
            .map(([k, v, n]) => `<div><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span><span class="n">${esc(n)}</span></div>`)
            .join("")}</div>
        </div>
      </div>`
    : `<div class="verdict info"><p class="summary">${icon("info", 16)} Health data wasn’t available for this drive. ${esc(d.smartError ?? "")}</p></div>`;

  const findings = h
    ? h.findings
        .map(
          (f) => `<div class="finding ${f.level}">${icon(f.level)}<div><b>${esc(f.title)}</b><p>${esc(f.detail)}</p>${
            f.action ? `<p class="next"><b>Next step:</b> ${esc(f.action)}</p>` : ""
          }</div></div>`,
        )
        .join("")
    : "";

  const indicatorRows = (h?.indicators ?? []).map(
    (i) => `<tr><td>${esc(i.label)}</td><td class="num">${esc(i.value)}</td><td class="ic">${icon(i.level)}</td></tr>`,
  );
  const half = Math.ceil(indicatorRows.length / 2);
  const indicators = [indicatorRows.slice(0, half), indicatorRows.slice(half)].map((r) => `<table><tbody>${r.join("")}</tbody></table>`).join("");

  const tests = s
    ? `${
        s.selfTests.length
          ? `<table><thead><tr><th>Self-test</th><th>Result</th><th class="num">At drive hour</th></tr></thead><tbody>${s.selfTests
              .slice(0, 6)
              .map(
                (t) =>
                  `<tr><td>${esc(t.kind)}</td><td>${icon(t.passed === false ? "critical" : t.passed ? "good" : "info", 12)} ${esc(t.status)}</td><td class="num">${esc(t.lifetimeHours ?? "—")}</td></tr>`,
              )
              .join("")}</tbody></table>`
          : `<p class="sub">No self-tests recorded.</p>`
      }${
        s.errorLogCount
          ? `<p class="sub" style="margin-top:8px">Drive error log: ${fmtNum(s.errorLogCount)} entr${s.errorLogCount === 1 ? "y" : "ies"}${
              s.errorLog.length
                ? `, most recent: ${esc(errorText(s.errorLog[0].description))}${s.errorLog[0].lba != null ? ` on sector ${fmtNum(s.errorLog[0].lba)}` : ""} at drive hour ${esc(s.errorLog[0].lifetimeHours ?? "?")}`
                : ""
            }.</p>`
          : `<p class="sub" style="margin-top:8px">Drive error log: no errors logged.</p>`
      }`
    : "";

  const historyTable = snaps.length > 1
    ? `<table><thead><tr><th>Checked</th><th>Health</th><th class="num">${s?.nvme ? "Life used" : "Pending"}</th><th class="num">${s?.nvme ? "Media errors" : "Replaced"}</th><th class="num">Errors</th><th class="num">Temp</th></tr></thead><tbody>${snaps
        .map(
          (x) =>
            `<tr><td>${esc(fmtDateTime(x.atMs))}</td><td>${icon(STATUS[x.status].level, 12)} ${x.score}% ${esc(STATUS[x.status].label)}</td><td class="num">${
              s?.nvme ? `${x.percentageUsed ?? "—"}%` : fmtNum(x.pending)
            }</td><td class="num">${s?.nvme ? fmtNum(x.mediaErrors) : fmtNum(x.reallocated)}</td><td class="num">${fmtNum(x.errorLog)}</td><td class="num">${
              x.temperature != null ? `${x.temperature} °C` : "—"
            }</td></tr>`,
        )
        .join("")}</tbody></table>`
    : "";

  const details: [string, string][] = [];
  if (s) {
    if (s.modelFamily) details.push(["Model family", s.modelFamily]);
    details.push(["Model", s.modelName ?? "—"], ["Serial number", s.serial ?? "—"], ["Firmware", s.firmware ?? "—"]);
    details.push(["Capacity", s.capacityBytes != null ? `${d.capacityLabel} (${fmtNum(s.capacityBytes)} bytes)` : d.capacityLabel]);
    if (s.rotationRate) details.push(["Rotation speed", `${fmtNum(s.rotationRate)} rpm`]);
    if (s.formFactor) details.push(["Form factor", s.formFactor]);
    if (s.smr) details.push(["Recording method", "SMR (shingled)"]);
    if (s.sataVersion) details.push(["Drive interface", `${s.sataVersion}${s.linkSpeed ? `, ${s.linkSpeed}` : ""}`]);
    details.push(["Data written / read", `${fmtBytes(s.bytesWritten)} / ${fmtBytes(s.bytesRead)}`]);
  }
  const usb = d.windows.usb;
  if (usb) {
    details.push(["USB adapter", `${usb.chip ?? "Unknown"} chip${usb.vendorId ? ` (ID ${usb.vendorId}:${usb.productId})` : ""}`]);
    details.push(["USB link", `${usb.link === "usb3" ? "USB 3 SuperSpeed" : usb.link === "usb2" ? "USB 2.0 Hi-Speed" : "Unknown"}${usb.port ? ` (port ${usb.port})` : ""}`]);
  }
  for (const v of d.windows.volumes) details.push([`Volume ${v.letter}:`, `${v.label ? `“${v.label}” · ` : ""}${v.fileSystem ?? ""} · ${fmtBytes(v.freeBytes)} free of ${fmtBytes(v.sizeBytes)}`]);

  const meta = [o.preparedBy && ["Prepared by", o.preparedBy], o.customer && ["Customer / asset", o.customer]].filter(Boolean) as [string, string][];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(d.title)} · Drive Health Report</title>
<style>
  @page { size: A4; margin: 14mm 14mm 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #0b0b0b; font: 10.5pt/1.45 "Segoe UI", system-ui, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { max-width: 182mm; margin: 0 auto; padding: 8mm 0; }
  @media print { .page { padding: 0; } }
  header.top { display: flex; align-items: center; gap: 12px; padding-bottom: 10px; border-bottom: 2px solid ${esc(brand.accent.light)}; }
  .logo { width: 38px; height: 38px; }
  header.top .org b { display: block; font-size: 13pt; }
  header.top .org span { color: #52514e; font-size: 9pt; }
  header.top .when { margin-left: auto; text-align: right; color: #52514e; font-size: 9pt; }
  header.top .when b { display: block; color: #0b0b0b; font-size: 11pt; }
  h1 { font-size: 17pt; margin: 14px 0 2px; letter-spacing: -0.01em; }
  .ident { color: #52514e; font-size: 9.5pt; margin-bottom: 10px; }
  .meta { display: flex; gap: 22px; font-size: 9.5pt; margin: 4px 0 10px; }
  .meta span { color: #52514e; }
  .verdict { display: grid; grid-template-columns: 140px 1fr; gap: 16px; border: 1px solid #e1e0d9; border-radius: 8px; padding: 12px 14px; break-inside: avoid; }
  .verdict.good { border-left: 4px solid #0ca30c; } .verdict.warning { border-left: 4px solid #fab219; } .verdict.critical { border-left: 4px solid #d03b3b; }
  .verdict.info { display: block; }
  .num-big { display: block; font-size: 34pt; font-weight: 650; line-height: 1; letter-spacing: -0.03em; }
  .num-big small { font-size: 16pt; color: #52514e; }
  .status { display: inline-flex; gap: 6px; align-items: center; font-weight: 600; margin-top: 6px; }
  .summary { margin: 0 0 8px; font-size: 11pt; }
  .keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .keys div { border-top: 1px solid #e7e6e1; padding-top: 5px; }
  .keys .k { display: block; color: #52514e; font-size: 8.5pt; }
  .keys .v { display: block; font-weight: 650; font-size: 12pt; }
  .keys .n { display: block; color: #52514e; font-size: 8pt; }
  section { margin-top: 14px; break-inside: avoid; }
  h2 { font-size: 11.5pt; margin: 0 0 6px; }
  .finding { display: grid; grid-template-columns: 16px 1fr; gap: 8px; padding: 7px 10px; border-radius: 6px; margin-bottom: 5px; background: #f3f3f1; break-inside: avoid; }
  .finding.warning { background: #fdf4de; } .finding.critical { background: #fcecec; } .finding.good { background: #eef7ee; }
  .finding svg { margin-top: 2px; }
  .finding p { margin: 2px 0 0; color: #3b3a37; }
  .finding .next { color: #0b0b0b; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  th { text-align: left; font-weight: 500; color: #52514e; font-size: 8.5pt; border-bottom: 1px solid #c3c2b7; padding: 4px 6px; }
  td { padding: 4px 6px; border-bottom: 1px solid #ecebe7; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .ind-wrap { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
  td.ic { width: 18px; }
  .sub { color: #52514e; font-size: 8.5pt; margin: 0 0 4px; }
  .warn { display: flex; gap: 6px; align-items: center; background: #fdf4de; padding: 6px 8px; border-radius: 6px; font-size: 9.5pt; }
  dl { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; margin: 0; font-size: 9.5pt; }
  dl div { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0; border-bottom: 1px solid #ecebe7; }
  dt { color: #52514e; } dd { margin: 0; text-align: right; font-weight: 500; }
  .notes { white-space: pre-wrap; border: 1px solid #e1e0d9; border-radius: 6px; padding: 8px 10px; }
  footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid #e1e0d9; color: #52514e; font-size: 8pt; line-height: 1.5; }
</style></head><body><div class="page">
<header class="top">${logo}<div class="org"><b>${esc(org)}</b><span>${esc(brand.companyName ? `${brand.appName} · Drive Health Report` : "Drive Health Report")}</span></div>
  <div class="when"><b>${esc(fmtDateTime(d.checkedAtMs))}</b>${d.connected ? "date of check" : "last check (drive not connected at export)"}</div></header>
<h1>${esc(d.title)}</h1>
<div class="ident">${esc(identity)}</div>
${meta.length ? `<div class="meta">${meta.map(([k, v]) => `<div><span>${esc(k)}:</span> <b>${esc(v)}</b></div>`).join("")}</div>` : ""}
${verdict}
${section("Findings", findings)}
${h ? `<section><h2>Health indicators</h2><div class="ind-wrap">${indicators}</div></section>` : ""}
${temp ? section(`Temperature, last ${tempHistoryHours(temp)} hours powered on`, tempChart(temp.values, temp.intervalMinutes, d.checkedAtMs) + `<p class="sub">Times are approximate: the drive logs only while powered on.</p>`) : ""}
${section("Self-tests and error log", tests)}
${speed ? section("Speed test", speedTable(speed)) : ""}
${section("Health history", historyTable)}
${o.notes.trim() ? section("Notes", `<div class="notes">${esc(o.notes.trim())}</div>`) : ""}
${section("Drive details", details.length ? `<dl>${details.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : "")}
<footer>
  ${brand.reportFooter ? `<div><b>${esc(brand.reportFooter)}</b></div>` : ""}
  ${contact ? `<div>${esc(org)} · ${esc(contact)}</div>` : ""}
  <div>Generated by ${esc(brand.appName)} ${esc(input.appVersion)} with smartmontools ${esc(input.smartctlVersion ?? "")}. Health readings are read-only. The health percentage is an estimate from the drive’s own counters; S.M.A.R.T. can’t predict every failure, so keep a backup of anything important.</div>
</footer>
</div></body></html>`;
}

/** Plain text for pasting into a ticket or chat. */
export function buildSummaryText(d: DriveReport, o: ReportOptions, appName: string): string {
  const s = d.smart;
  const h = d.health;
  const lines: string[] = [];
  const head = `${d.title}${s?.serial ? ` (SN ${s.serial})` : ""}`;
  lines.push(h ? `${head}: ${h.score}% ${STATUS[h.status].label}` : `${head}: health data not available`);
  lines.push(`Checked ${fmtDateTime(d.checkedAtMs)} with ${appName}`);
  if (o.customer) lines.push(`Customer / asset: ${o.customer}`);
  if (o.preparedBy) lines.push(`Prepared by: ${o.preparedBy}`);
  if (h) {
    lines.push("", h.summary);
    const notable = h.findings.filter((f) => f.level === "warning" || f.level === "critical");
    for (const f of notable) lines.push(`- ${f.title}.${f.action ? ` Next step: ${f.action}` : ""}`);
    lines.push("", keyNumbers(d).map(([k, v]) => `${k}: ${v}`).join(" · "));
  } else if (d.smartError) {
    lines.push("", d.smartError);
  }
  if (o.notes.trim()) lines.push("", `Notes: ${o.notes.trim()}`);
  return lines.join("\n");
}

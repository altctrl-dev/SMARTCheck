import { useEffect, useRef } from "react";
import type { DriveReport } from "../types";
import { STATUS, fmtBytes, fmtHours, fmtNum } from "../format";
import { CloseIcon, StatusIcon } from "./Icons";

export type DetailsTab = "findings" | "score" | "attributes" | "tests" | "drive";

const TABS: { id: DetailsTab; label: string }[] = [
  { id: "findings", label: "Findings" },
  { id: "score", label: "Score" },
  { id: "attributes", label: "Attributes" },
  { id: "tests", label: "Self-tests & errors" },
  { id: "drive", label: "Drive" },
];

interface Props {
  drive: DriveReport;
  tab: DetailsTab;
  onTab: (t: DetailsTab) => void;
  onClose: () => void;
}

export function DetailsPanel({ drive, tab, onTab, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="panel" role="dialog" aria-modal="true" aria-label={`${drive.title} details`}>
        <header className="panel-head">
          <div>
            <h2>{drive.title}</h2>
            <span className="sub">{drive.smart?.serial ? `SN ${drive.smart.serial}` : `Disk ${drive.diskNumber}`}</span>
          </div>
          <button className="icon-btn" ref={closeRef} onClick={onClose} aria-label="Close details">
            <CloseIcon />
          </button>
        </header>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => onTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="panel-body">
          {tab === "findings" && <Findings drive={drive} />}
          {tab === "score" && <Score drive={drive} />}
          {tab === "attributes" && <Attributes drive={drive} />}
          {tab === "tests" && <Tests drive={drive} />}
          {tab === "drive" && <DriveInfo drive={drive} />}
        </div>
      </aside>
    </div>
  );
}

function Findings({ drive }: { drive: DriveReport }) {
  const h = drive.health;
  if (!h) return <p className="muted-text">{drive.smartError}</p>;
  return (
    <div className="finding-list">
      {h.findings.map((f) => (
        <div key={f.title} className={`finding-row ${f.level}`}>
          <StatusIcon level={f.level} size={18} />
          <div>
            <b>{f.title}</b>
            <p>{f.detail}</p>
            {f.action && (
              <p className="f-action">
                <b>Next step:</b> {f.action}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Score({ drive }: { drive: DriveReport }) {
  const h = drive.health;
  if (!h) return null;
  const st = STATUS[h.status];
  return (
    <>
      <p className="muted-text">
        The score starts at 100% and loses points for each sign of wear or failure, weighted by how strongly it predicts failure. The status is <b>Caution</b> whenever a
        drive has bad, pending or unreadable sectors, logged errors or a failed self-test, whatever the percentage. Commercial tools use their own formulas, so their number
        may differ.
      </p>
      <table className="tbl">
        <thead>
          <tr>
            <th>Factor</th>
            <th>Rule</th>
            <th className="num">This drive</th>
            <th className="num">Points</th>
          </tr>
        </thead>
        <tbody>
          {h.deductions.map((d) => (
            <tr key={d.factor}>
              <td>{d.factor}</td>
              <td className="muted-text">{d.rule}</td>
              <td className="num">{d.value}</td>
              <td className="num">{d.points ? `−${d.points}` : "0"}</td>
            </tr>
          ))}
          <tr className="total">
            <td>Health</td>
            <td className="muted-text">{st.label}</td>
            <td />
            <td className="num">{h.score}%</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function Attributes({ drive }: { drive: DriveReport }) {
  const s = drive.smart;
  if (!s) return null;
  if (s.nvme) {
    const n = s.nvme;
    const rows: [string, string][] = [
      ["Critical warning", n.criticalWarning ? `0x${n.criticalWarning.toString(16).toUpperCase()}` : "None"],
      ["Percentage used", `${n.percentageUsed ?? "—"}%`],
      ["Available spare", `${n.availableSpare ?? "—"}% (threshold ${n.availableSpareThreshold ?? "—"}%)`],
      ["Media errors", fmtNum(n.mediaErrors)],
      ["Error log entries", fmtNum(n.errorLogEntries)],
      ["Unsafe shutdowns", n.unsafeShutdowns != null ? fmtNum(n.unsafeShutdowns) : "—"],
      ["Data written", fmtBytes(s.bytesWritten)],
      ["Data read", fmtBytes(s.bytesRead)],
      ["Power-on time", fmtHours(s.powerOnHours)],
      ["Power cycles", s.powerCycles != null ? fmtNum(s.powerCycles) : "—"],
    ];
    return <KV rows={rows} />;
  }
  return (
    <>
      <p className="muted-text">
        “Value” is a normalized score that counts down as the drive wears; an attribute fails when it reaches its threshold. A threshold of 0 means the attribute is
        informational only.
      </p>
      <table className="tbl attrs">
        <thead>
          <tr>
            <th className="num">ID</th>
            <th>Attribute</th>
            <th className="num">Value</th>
            <th className="num">Worst</th>
            <th className="num">Thresh</th>
            <th className="num">Raw</th>
          </tr>
        </thead>
        <tbody>
          {s.attributes.map((a) => {
            const failing = a.thresh > 0 && a.value <= a.thresh;
            return (
              <tr key={a.id} className={failing ? "failing" : undefined}>
                <td className="num">{a.id}</td>
                <td>
                  {a.name.replace(/_/g, " ")}
                  {a.prefail && <span className="tag">Pre-fail</span>}
                </td>
                <td className="num">{a.value}</td>
                <td className="num">{a.worst}</td>
                <td className="num">{a.thresh}</td>
                <td className="num">{a.rawString || fmtNum(a.raw)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function Tests({ drive }: { drive: DriveReport }) {
  const s = drive.smart;
  if (!s) return null;
  return (
    <>
      <h3>Self-tests</h3>
      {s.selfTests.length === 0 ? (
        <p className="muted-text">No self-tests recorded.</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Test</th>
              <th>Result</th>
              <th className="num">At drive hour</th>
            </tr>
          </thead>
          <tbody>
            {s.selfTests.map((t, i) => (
              <tr key={i}>
                <td>{t.kind}</td>
                <td>
                  <span className="status-inline">
                    <StatusIcon level={t.passed === false ? "critical" : t.passed ? "good" : "info"} size={14} />
                    {t.status}
                    {t.lbaFirstError != null && ` (sector ${fmtNum(t.lbaFirstError)})`}
                  </span>
                </td>
                <td className="num">{t.lifetimeHours ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(s.selfTestMinutesShort != null || s.selfTestMinutesExtended != null) && (
        <p className="muted-text">
          A short test takes about {s.selfTestMinutesShort ?? "?"} minutes; an extended test about {fmtHours(Math.round((s.selfTestMinutesExtended ?? 0) / 60))}.
        </p>
      )}
      <h3>Drive error log</h3>
      {s.errorLogCount === 0 ? (
        <p className="muted-text">No errors logged.</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>Error</th>
              <th className="num">Sector</th>
              <th className="num">At drive hour</th>
            </tr>
          </thead>
          <tbody>
            {s.errorLog.map((e) => (
              <tr key={e.number}>
                <td>{e.number}</td>
                <td>{errorText(e.description)}</td>
                <td className="num">{e.lba != null ? fmtNum(e.lba) : "—"}</td>
                <td className="num">{e.lifetimeHours ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

const ATA_ERRORS: Record<string, string> = {
  UNC: "Unreadable data (uncorrectable)",
  ABRT: "Command aborted",
  IDNF: "Sector not found",
  ICRC: "Transfer error (CRC)",
  AMNF: "Address mark not found",
  TK0NF: "Track 0 not found",
  MC: "Media changed",
  WP: "Write protected",
};

/** "Error: UNC at LBA = 0x0001040c = 66572" -> "Unreadable data (uncorrectable)" */
function errorText(description: string): string {
  const codes = description.replace(/^Error:\s*/, "").replace(/\s+at LBA.*$/, "").split(/[\s,]+/).filter(Boolean);
  const words = codes.map((c) => ATA_ERRORS[c] ?? c);
  return words.join(", ") || description;
}

function DriveInfo({ drive }: { drive: DriveReport }) {
  const s = drive.smart;
  const w = drive.windows;
  const rows: [string, string][] = [];
  if (s) {
    if (s.modelFamily) rows.push(["Model family", s.modelFamily]);
    rows.push(["Model", s.modelName ?? "—"], ["Serial number", s.serial ?? "—"], ["Firmware", s.firmware ?? "—"]);
    rows.push(["Capacity", s.capacityBytes != null ? `${drive.capacityLabel} (${fmtNum(s.capacityBytes)} bytes)` : drive.capacityLabel]);
    if (s.rotationRate) rows.push(["Rotation speed", `${fmtNum(s.rotationRate)} rpm`]);
    if (s.formFactor) rows.push(["Form factor", s.formFactor]);
    if (s.smr) rows.push(["Recording method", "SMR (shingled)"]);
    if (s.sataVersion) rows.push(["Drive interface", `${s.sataVersion}${s.linkSpeed ? `, ${s.linkSpeed}` : ""}`]);
    rows.push(["Data written / read", `${fmtBytes(s.bytesWritten)} / ${fmtBytes(s.bytesRead)}`]);
  } else {
    rows.push(["Name", w.friendlyName ?? "—"], ["Capacity", drive.capacityLabel]);
  }
  rows.push(["Windows disk", `Disk ${w.number}${w.isSystem ? " (system)" : ""}`]);
  if (w.usb) {
    rows.push(["USB adapter", `${w.usb.chip ?? "Unknown"} chip${w.usb.vendorId ? ` (ID ${w.usb.vendorId}:${w.usb.productId})` : ""}`]);
    rows.push([
      "USB link",
      `${w.usb.link === "usb3" ? "USB 3 SuperSpeed" : w.usb.link === "usb2" ? "USB 2.0 Hi-Speed" : "Unknown"}${w.usb.port ? ` (port ${w.usb.port})` : ""}${w.usb.driver ? ` · ${w.usb.driver}` : ""}`,
    ]);
  } else if (w.busType) {
    rows.push(["Bus", w.busType]);
  }
  for (const v of w.volumes) {
    rows.push([`Volume ${v.letter}:`, `${v.label ? `“${v.label}” · ` : ""}${v.fileSystem ?? ""} · ${fmtBytes(v.freeBytes)} free of ${fmtBytes(v.sizeBytes)}`]);
  }
  return <KV rows={rows} />;
}

function KV({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

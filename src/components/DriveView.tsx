import { useEffect, useState } from "react";
import { isDesktop } from "../api";
import type { DriveReport, Health, Level, ScanResult, SmartInfo } from "../types";
import { STATUS, fmtBytes, fmtDateTime, fmtHours, fmtNum, fmtTime, tempLevel } from "../format";
import { DetailsIcon, RefreshIcon, StatusIcon } from "./Icons";
import { TempChart } from "./TempChart";
import type { DetailsTab } from "./DetailsPanel";
import { SelfTestMenu, SelfTestStrip, useSelfTest } from "./SelfTest";
import { SpeedTestPanel, speedTestBlocker } from "./SpeedTestPanel";

interface Props {
  drive: DriveReport;
  scan: ScanResult;
  scanning: boolean;
  onRescan: () => void;
  onDetails: (tab: DetailsTab) => void;
}

export function DriveView({ drive, scan, scanning, onRescan, onDetails }: Props) {
  const s = drive.smart;
  const h = drive.health;
  const selfTest = useSelfTest(drive, onRescan);
  // Browser preview only: ?speed=open|run and ?selftest=short|long open those states for screenshots.
  const preview = isDesktop ? null : new URLSearchParams(window.location.search);
  const [speedOpen, setSpeedOpen] = useState(preview?.get("speed") != null);
  const previewSelfTest = preview?.get("selftest");
  useEffect(() => {
    if (previewSelfTest === "short" || previewSelfTest === "long") selfTest.start(previewSelfTest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSelfTest]);
  const canAct = drive.connected && scan.elevated && !!s;
  const speedBlocker = speedTestBlocker(drive, selfTest.running);
  const vols = drive.windows.volumes
    .map((v) => (v.label ? `${v.letter}: “${v.label}”` : `${v.letter}:`))
    .join(", ");
  const model = s?.modelName ?? drive.windows.friendlyName;
  const meta = [
    model && model !== drive.title ? model : null,
    s?.serial ? `SN ${s.serial}` : null,
    drive.capacityLabel,
    vols || null,
    drive.connected ? `checked ${fmtTime(drive.checkedAtMs || scan.scannedAtMs)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="drive-view">
      <header className="dv-head">
        <div className="dv-titles">
          <h1>{drive.title}</h1>
          <div className="meta">{meta}</div>
        </div>
        <div className="actions">
          {drive.connected && (
            <button className="btn ghost" onClick={onRescan} disabled={scanning}>
              <RefreshIcon className={scanning ? "spin" : undefined} />
              {scanning ? "Checking…" : "Re-check"}
            </button>
          )}
          {drive.connected && <SelfTestMenu drive={drive} st={selfTest} disabled={!canAct} />}
          {drive.connected && (
            <button
              className="btn"
              onClick={() => setSpeedOpen(true)}
              disabled={!canAct || selfTest.running}
              title={speedBlocker ?? "Measure read and write speed"}
            >
              Speed test
            </button>
          )}
          <button className="btn" onClick={() => onDetails("findings")} disabled={!s}>
            <DetailsIcon />
            Details
          </button>
        </div>
      </header>

      {!drive.connected && (
        <div className="banner info">
          <StatusIcon level="info" />
          <span>
            <b>Not connected.</b> This is the report from {fmtDateTime(drive.checkedAtMs)}. Plug the drive in and choose Rescan drives to check it again.
          </span>
        </div>
      )}
      <SelfTestStrip drive={drive} st={selfTest} />
      {speedOpen && (
        <SpeedTestPanel
          drive={drive}
          selfTestRunning={selfTest.running}
          autoStart={preview?.get("speed") === "run"}
          onClose={() => setSpeedOpen(false)}
          onFinished={() => undefined}
        />
      )}

      {s && h ? (
        <>
          <div className="row-a">
            <HealthCard h={h} onWhy={() => onDetails("score")} />
            <FindingCard h={h} onMore={() => onDetails("findings")} />
          </div>
          <Tiles drive={drive} s={s} />
          <div className="row-c">
            <section className="card ind-card">
              <div className="card-h">
                <h2>Health indicators</h2>
                <button className="link" onClick={() => onDetails("attributes")}>
                  {s.attributes.length ? `All ${s.attributes.length} attributes ›` : "All details ›"}
                </button>
              </div>
              <div className="ind-grid">
                {h.indicators.slice(0, 10).map((i) => (
                  <div className="ind" key={i.label} title={i.help}>
                    <span className="ind-label">{i.label}</span>
                    <span className="ind-value">{i.value}</span>
                    <StatusIcon level={i.level} />
                  </div>
                ))}
              </div>
            </section>
            {s.tempHistory ? (
              <section className="card chart-card">
                <div className="card-h">
                  <h2>Temperature</h2>
                  <span className="sub">
                    last {Math.round((s.tempHistory.values.length * s.tempHistory.intervalMinutes) / 60)} hours powered on
                    {s.tempHistory.intervalMinutes > 1 ? ` · every ${s.tempHistory.intervalMinutes} min` : ""} · °C
                  </span>
                </div>
                <TempChart history={s.tempHistory} endMs={drive.checkedAtMs || scan.scannedAtMs} />
              </section>
            ) : (
              <UsageCard s={s} />
            )}
          </div>
        </>
      ) : (
        <NoHealth drive={drive} />
      )}
    </div>
  );
}

function HealthCard({ h, onWhy }: { h: Health; onWhy: () => void }) {
  const st = STATUS[h.status];
  return (
    <section className="card health">
      <div className="lbl">Estimated health</div>
      <div className="big">
        {h.score}
        <span>%</span>
      </div>
      <div className={`state ${st.level}`}>
        <StatusIcon level={st.level} size={18} />
        {st.label}
      </div>
      <div className={`meter ${st.level}`} role="meter" aria-label="Estimated health" aria-valuemin={0} aria-valuemax={100} aria-valuenow={h.score}>
        <span style={{ width: `${h.score}%` }} />
      </div>
      <button className="link why" onClick={onWhy}>
        Why {h.score}%? ›
      </button>
    </section>
  );
}

function FindingCard({ h, onMore }: { h: Health; onMore: () => void }) {
  const [top, ...rest] = h.findings;
  if (!top) return <section className="card finding good" />;
  return (
    <section className={`card finding ${top.level}`}>
      <div className="f-head">
        <StatusIcon level={top.level} size={18} />
        <h2>{top.title}</h2>
      </div>
      <p className="f-detail">{top.detail}</p>
      {top.action && (
        <p className="f-action">
          <b>Next step:</b> {top.action}
        </p>
      )}
      {rest.length > 0 && (
        <div className="f-more">
          <span>Also noted:</span>
          {rest.map((f) => (
            <button key={f.title} className="chip" onClick={onMore}>
              <StatusIcon level={f.level} size={12} />
              {f.title}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Tile({ label, value, unit, note, icon, meter }: { label: string; value: string; unit?: string; note: string; icon?: Level; meter?: { pct: number; level: Level } }) {
  return (
    <section className="card tile">
      <div className="lbl">{label}</div>
      <div className="tv">
        {icon && <StatusIcon level={icon} size={18} />}
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {meter && (
        <div className={`meter thin ${meter.level}`}>
          <span style={{ width: `${Math.max(0, Math.min(100, meter.pct))}%` }} />
        </div>
      )}
      <div className="note">{note}</div>
    </section>
  );
}

function Tiles({ drive, s }: { drive: DriveReport; s: SmartInfo }) {
  const limit = s.tempLimit ?? (drive.kind === "hdd" ? 60 : 70);
  const tl = tempLevel(s.temperature, limit);
  const life = s.temperature != null && s.tempLifetimeMin != null && s.tempLifetimeMax != null ? ` · lifetime ${s.tempLifetimeMin}–${s.tempLifetimeMax} °C` : "";
  const tempWord = tl === "critical" ? "Too hot" : tl === "warning" ? "Warm" : "Normal";

  const tiles = [
    <Tile
      key="temp"
      label="Temperature"
      value={s.temperature != null ? String(s.temperature) : "—"}
      unit={s.temperature != null ? "°C" : undefined}
      meter={s.temperature != null ? { pct: (s.temperature / limit) * 100, level: tl } : undefined}
      note={s.temperature != null ? `${tempWord}${life}` : "Not reported"}
    />,
  ];

  if (drive.kind === "nvme" && s.nvme) {
    const used = s.nvme.percentageUsed ?? 0;
    tiles.push(
      <Tile
        key="life"
        label="Life used"
        value={String(used)}
        unit="%"
        meter={{ pct: used, level: used >= 90 ? "critical" : used >= 70 ? "warning" : "good" }}
        note={s.nvme.availableSpare != null ? `${s.nvme.availableSpare}% spare blocks left` : "Of rated write endurance"}
      />,
      <Tile key="written" label="Data written" value={fmtBytes(s.bytesWritten)} note={`${fmtBytes(s.bytesRead)} read · ${fmtHours(s.powerOnHours)}`} />,
    );
  } else {
    const hours = s.powerOnHours;
    tiles.push(
      <Tile
        key="hours"
        label="Power-on time"
        value={hours != null ? fmtNum(hours) : "—"}
        unit={hours != null ? (hours === 1 ? "hour" : "hours") : undefined}
        note={[hours != null && hours < 100 ? "Nearly new" : null, s.powerCycles != null ? `${fmtNum(s.powerCycles)} power cycles` : null].filter(Boolean).join(" · ")}
      />,
    );
    const errs = s.errorLogCount;
    const lbas = new Set(s.errorLog.map((e) => e.lba).filter((x) => x != null));
    tiles.push(
      <Tile
        key="errors"
        label="Errors logged"
        value={fmtNum(errs)}
        icon={errs > 0 ? "warning" : undefined}
        note={errs === 0 ? "No read or write failures" : lbas.size === 1 && errs > 1 ? "All on the same sector" : `Latest at drive hour ${s.errorLog[0]?.lifetimeHours ?? "?"}`}
      />,
    );
  }

  const usb = drive.windows.usb;
  if (usb) {
    const v = usb.link === "usb3" ? "USB 3" : usb.link === "usb2" ? "USB 2.0" : "USB";
    const note =
      usb.link === "usb3"
        ? `SuperSpeed${usb.port ? ` · ${usb.port}` : ""}${usb.driver ? ` · ${usb.driver}` : ""}`
        : usb.link === "usb2"
          ? "Hi-Speed · limits speed to ~40 MB/s"
          : "Link speed unknown";
    tiles.push(<Tile key="conn" label="Connection" value={v} icon={usb.link === "usb3" ? "good" : usb.link === "usb2" ? "warning" : undefined} note={note} />);
  } else {
    const bus = drive.kind === "nvme" ? "NVMe" : drive.windows.busType ?? "Internal";
    tiles.push(<Tile key="conn" label="Connection" value={bus} note={s.linkSpeed ? `Internal · ${s.linkSpeed}` : "Internal drive"} />);
  }

  return <div className="row-b">{tiles}</div>;
}

function UsageCard({ s }: { s: SmartInfo }) {
  const rows: [string, string][] = [
    ["Power-on time", fmtHours(s.powerOnHours)],
    ["Power cycles", s.powerCycles != null ? fmtNum(s.powerCycles) : "—"],
    ["Data written", fmtBytes(s.bytesWritten)],
    ["Data read", fmtBytes(s.bytesRead)],
  ];
  if (s.nvme?.unsafeShutdowns != null) rows.push(["Unsafe shutdowns", fmtNum(s.nvme.unsafeShutdowns)]);
  if (s.temperature != null) rows.push(["Temperature now", `${s.temperature} °C`]);
  return (
    <section className="card usage-card">
      <div className="card-h">
        <h2>Usage</h2>
        <span className="sub">lifetime counters</span>
      </div>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="note">This drive doesn’t keep a temperature log.</p>
    </section>
  );
}

function NoHealth({ drive }: { drive: DriveReport }) {
  const w = drive.windows;
  const rows: [string, string][] = [
    ["Capacity", drive.capacityLabel || "—"],
    ["Connection", w.usb ? `USB${w.usb.chip ? ` · ${w.usb.chip} adapter` : ""}` : w.busType ?? "—"],
    ["Volumes", w.volumes.map((v) => `${v.letter}: ${v.fileSystem ?? ""} · ${fmtBytes(v.freeBytes)} free`).join(", ") || "None"],
  ];
  return (
    <section className="card no-health">
      <div className="f-head">
        <StatusIcon level="info" size={18} />
        <h2>Health data isn’t available for this drive</h2>
      </div>
      <p className="f-detail">{drive.smartError ?? "The drive didn’t report any health data."}</p>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

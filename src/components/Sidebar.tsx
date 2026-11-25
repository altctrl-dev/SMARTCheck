import type { DriveReport, ScanResult } from "../types";
import { brand, logo } from "../brand";
import { STATUS, driveSubtitle, fmtDayTime, isExternal } from "../format";
import { DriveIcon, RefreshIcon, StatusIcon } from "./Icons";
import { openLink } from "../api";

interface Props {
  scan: ScanResult | null;
  selectedKey: string | null;
  scanning: boolean;
  onSelect: (key: string) => void;
  onRescan: () => void;
}

export function Sidebar({ scan, selectedKey, scanning, onSelect, onRescan }: Props) {
  const drives = scan?.drives ?? [];
  const external = drives.filter(isExternal);
  const internal = drives.filter((d) => !isExternal(d));
  const s = brand.support;
  const hasSupport = s.phone || s.email || s.website;

  return (
    <aside className="side">
      <div className="brand">
        <img src={logo} alt="" width={36} height={36} />
        <div>
          <b>{brand.companyName || brand.appName}</b>
          <span>{brand.companyName ? brand.appName : "Drive health checker"}</span>
        </div>
      </div>

      <nav className="drive-list" aria-label="Drives">
        {external.length > 0 && <Group label="External" drives={external} selectedKey={selectedKey} onSelect={onSelect} />}
        {internal.length > 0 && <Group label="Internal" drives={internal} selectedKey={selectedKey} onSelect={onSelect} />}
        {(scan?.offline.length ?? 0) > 0 && <Group label="Previously checked" drives={scan!.offline} selectedKey={selectedKey} onSelect={onSelect} />}
        {scan && drives.length === 0 && <p className="side-empty">No drives found.</p>}
      </nav>

      <div className="side-bottom">
        <button className="side-btn" onClick={onRescan} disabled={scanning}>
          <RefreshIcon className={scanning ? "spin" : undefined} />
          {scanning ? "Scanning…" : "Rescan drives"}
        </button>
        {hasSupport && (
          <div className="support">
            Need help? {brand.companyName}
            {s.phone && <div>{s.phone}</div>}
            {s.email && (
              <button className="text-link" onClick={() => openLink(`mailto:${s.email}`)}>
                {s.email}
              </button>
            )}
            {s.website && (
              <button className="text-link" onClick={() => openLink(s.website.startsWith("http") ? s.website : `https://${s.website}`)}>
                {s.website}
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function Group({ label, drives, selectedKey, onSelect }: { label: string; drives: DriveReport[]; selectedKey: string | null; onSelect: (k: string) => void }) {
  return (
    <>
      <div className="s-label">{label}</div>
      {drives.map((d) => {
        const st = d.health ? STATUS[d.health.status] : null;
        return (
          <button
            key={d.key}
            className={`drive-item${d.key === selectedKey ? " sel" : ""}${d.connected ? "" : " offline"}`}
            onClick={() => onSelect(d.key)}
            aria-current={d.key === selectedKey ? "true" : undefined}
          >
            <DriveIcon kind={d.kind} />
            <span className="di-text">
              <b>{d.title}</b>
              <span>{d.connected ? driveSubtitle(d) : `${d.smart?.serial ? `…${d.smart.serial.slice(-4)} · ` : ""}${fmtDayTime(d.checkedAtMs)}`}</span>
            </span>
            {d.health && st ? (
              <span className="di-score" title={st.label}>
                <StatusIcon level={st.level} size={13} />
                {d.health.score}%
              </span>
            ) : (
              <span className="di-score muted">—</span>
            )}
          </button>
        );
      })}
    </>
  );
}

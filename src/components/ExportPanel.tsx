import { useEffect, useRef, useState } from "react";
import type { DriveHistory, DriveReport } from "../types";
import { appVersion, exportReport, getHistory, showInFolder, isDesktop } from "../api";
import { brand, logo } from "../brand";
import { buildReportHtml, buildSummaryText, type ReportOptions } from "../report";
import { CloseIcon, StatusIcon } from "./Icons";

const PREPARED_BY_KEY = "smartcheck.preparedBy";

function remembered(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: fine, it's only a convenience */
  }
}

/** "SMARTCheck_WD-Blue-Mobile-1-TB_WXD2A5156PC4_2026-11-25" */
function baseName(d: DriveReport): string {
  const day = new Date(d.checkedAtMs || Date.now());
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  const parts = [brand.appName, d.title, d.smart?.serial ?? "", date].filter(Boolean);
  return parts.join("_").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
}

export async function makeReportHtml(drive: DriveReport, history: DriveHistory | null, options: ReportOptions, smartctlVersion: string | null) {
  const [logoSvg, version] = await Promise.all([
    fetch(logo)
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null),
    appVersion(),
  ]);
  return buildReportHtml({ drive, history, options, brand, logoSvg, appVersion: version, smartctlVersion });
}

interface Props {
  drive: DriveReport;
  smartctlVersion: string | null;
  onClose: () => void;
}

export function ExportPanel({ drive, smartctlVersion, onClose }: Props) {
  const [opts, setOpts] = useState<ReportOptions>(() => ({
    preparedBy: remembered(PREPARED_BY_KEY),
    customer: "",
    notes: "",
    includeSpeed: true,
    includeHistory: true,
  }));
  const [history, setHistory] = useState<DriveHistory | null>(null);
  const [busy, setBusy] = useState<"pdf" | "html" | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getHistory(drive.key).then(setHistory).catch(() => setHistory(null));
  }, [drive.key]);

  useEffect(() => {
    firstField.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const hasSpeed = !!history?.speedRuns.some((r) => r.results.length > 0);
  const hasHistory = (history?.snapshots.length ?? 0) > 1;
  const set = <K extends keyof ReportOptions>(k: K, v: ReportOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));

  const save = async (format: "pdf" | "html") => {
    setBusy(format);
    setError(null);
    setSaved(null);
    remember(PREPARED_BY_KEY, opts.preparedBy.trim());
    try {
      const html = await makeReportHtml(drive, history, opts, smartctlVersion);
      const path = await exportReport(html, format, baseName(drive));
      if (path) setSaved(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(buildSummaryText(drive, opts, brand.appName));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      setError(`Couldn’t copy to the clipboard: ${String(e)}`);
    }
  };

  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <section className="modal export" role="dialog" aria-modal="true" aria-label={`Export report, ${drive.title}`}>
        <header className="panel-head">
          <div>
            <h2>Export report</h2>
            <span className="sub">
              {drive.title}
              {drive.smart?.serial ? ` · SN ${drive.smart.serial}` : ""}
            </span>
          </div>
          <button className="icon-btn" onClick={onClose} disabled={!!busy} aria-label="Close">
            <CloseIcon />
          </button>
        </header>
        <div className="export-body">
          <p className="muted-text">
            A one- or two-page report{brand.companyName ? ` with ${brand.companyName}’s logo and contact details` : ""}: health, findings and next steps, indicators,
            temperature, self-tests{hasSpeed ? ", the latest speed test" : ""}{hasHistory ? " and history" : ""}.
          </p>
          <label className="field">
            <span>Prepared by</span>
            <input ref={firstField} value={opts.preparedBy} onChange={(e) => set("preparedBy", e.target.value)} placeholder="Your name (remembered)" />
          </label>
          <label className="field">
            <span>Customer / asset</span>
            <input value={opts.customer} onChange={(e) => set("customer", e.target.value)} placeholder="e.g. ticket number, owner or asset tag" />
          </label>
          <label className="field">
            <span>Notes</span>
            <textarea rows={3} value={opts.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Anything to add for the reader" />
          </label>
          <div className="checks">
            <label className={hasSpeed ? "" : "disabled"}>
              <input type="checkbox" checked={opts.includeSpeed && hasSpeed} disabled={!hasSpeed} onChange={(e) => set("includeSpeed", e.target.checked)} />
              Include the latest speed test{hasSpeed ? "" : " (none yet)"}
            </label>
            <label className={hasHistory ? "" : "disabled"}>
              <input type="checkbox" checked={opts.includeHistory && hasHistory} disabled={!hasHistory} onChange={(e) => set("includeHistory", e.target.checked)} />
              Include health history{hasHistory ? "" : " (one check so far)"}
            </label>
          </div>
          {error && (
            <div className="banner critical">
              <StatusIcon level="critical" />
              <span>{error}</span>
            </div>
          )}
          {saved && (
            <div className="banner good">
              <StatusIcon level="good" />
              <span className="saved-path">Saved to {saved}</span>
              {isDesktop && (
                <button className="btn" onClick={() => showInFolder(saved)}>
                  Show in folder
                </button>
              )}
            </div>
          )}
        </div>
        <footer className="modal-foot">
          <button className="btn ghost copy" onClick={copy}>
            {copied ? "Copied ✓" : "Copy summary"}
          </button>
          <button className="btn" onClick={() => save("html")} disabled={!!busy}>
            {busy === "html" ? "Saving…" : "Save HTML…"}
          </button>
          <button className="btn primary" onClick={() => save("pdf")} disabled={!!busy}>
            {busy === "pdf" ? "Making PDF…" : "Save PDF…"}
          </button>
        </footer>
      </section>
    </div>
  );
}

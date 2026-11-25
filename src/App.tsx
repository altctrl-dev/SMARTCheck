import { useCallback, useEffect, useState } from "react";
import type { ScanResult } from "./types";
import { isDesktop, restartAsAdmin, scanDrives } from "./api";
import { fmtDateTime, fmtTime, isExternal } from "./format";
import { Sidebar } from "./components/Sidebar";
import { DriveView } from "./components/DriveView";
import { DetailsPanel, type DetailsTab } from "./components/DetailsPanel";
import { ShieldIcon, StatusIcon } from "./components/Icons";

// Browser preview only: ?drive=<serial>&details=<tab> opens a given state (used for screenshots).
const previewParams = isDesktop ? null : new URLSearchParams(window.location.search);

export default function App() {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(previewParams?.get("drive") ?? null);
  const [details, setDetails] = useState<DetailsTab | null>((previewParams?.get("details") as DetailsTab | null) ?? null);

  const runScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const result = await scanDrives();
      setScan(result);
      setSelectedKey((prev) => {
        if (prev && result.drives.some((d) => d.key === prev)) return prev;
        const first = result.drives.find(isExternal) ?? result.drives[0];
        return first?.key ?? null;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    runScan();
  }, [runScan]);

  const drive = scan?.drives.find((d) => d.key === selectedKey) ?? null;
  const closeDetails = useCallback(() => setDetails(null), []);

  return (
    <div className="app">
      <Sidebar scan={scan} selectedKey={selectedKey} scanning={scanning} onSelect={setSelectedKey} onRescan={runScan} />
      <main className="main">
        {scan && !scan.elevated && isDesktop && (
          <div className="banner warning">
            <ShieldIcon />
            <div>
              <b>Administrator rights needed</b>
              <span>SMARTCheck can list your drives, but reading their health needs administrator rights.</span>
            </div>
            <button className="btn primary" onClick={() => restartAsAdmin().catch((e) => setError(String(e)))}>
              Restart as administrator
            </button>
          </div>
        )}
        {scan?.warnings.map((w) => (
          <div className="banner warning" key={w}>
            <StatusIcon level="warning" />
            <span>{w}</span>
          </div>
        ))}
        {error && (
          <div className="banner critical">
            <StatusIcon level="critical" />
            <span>{error}</span>
            <button className="btn" onClick={runScan}>
              Try again
            </button>
          </div>
        )}

        {!scan && !error && (
          <div className="center-state">
            <div className="spinner" />
            <p>Reading your drives…</p>
          </div>
        )}
        {scan && drive && (
          <DriveView drive={drive} scan={scan} scanning={scanning} onRescan={runScan} onDetails={setDetails} />
        )}
        {scan && !drive && scan.drives.length === 0 && (
          <div className="center-state">
            <p>No drives found. Plug in a drive and choose Rescan drives.</p>
          </div>
        )}

        <footer className="status-bar">
          <span>
            <i className="dot" />
            Read-only check
          </span>
          {scan?.smartctlVersion && <span>smartmontools {scan.smartctlVersion}</span>}
          {scan && <span title={fmtDateTime(scan.scannedAtMs)}>Scanned {fmtTime(scan.scannedAtMs)}</span>}
          <span>Results stay on this PC</span>
          {!isDesktop && scan && <span className="preview-chip">Preview data · {fmtDateTime(scan.scannedAtMs)}</span>}
        </footer>
      </main>
      {drive && details && <DetailsPanel drive={drive} tab={details} onTab={setDetails} onClose={closeDetails} />}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { DriveReport, Measurement, SpeedProgress, SpeedRun, StepState, Volume } from "../types";
import { cancelSpeedTest, getHistory, startSpeedTest } from "../api";
import { fmtBytes, fmtDateTime } from "../format";
import { CloseIcon, StatusIcon } from "./Icons";

const MIN_FREE = 3 * 1024 ** 3;

const CHECKS = [
  { id: "identity", label: "Confirm it’s the right drive" },
  { id: "space", label: "Check free space" },
  { id: "health", label: "Check for problem sectors" },
  { id: "prepare", label: "Write a 1 GB test file" },
];
const ROWS = [
  { label: "Sequential 1 MB", sub: "queue 8", read: "seq1m_q8_read", write: "seq1m_q8_write" },
  { label: "Sequential 1 MB", sub: "queue 1", read: "seq1m_q1_read", write: "seq1m_q1_write" },
  { label: "Random 4 KB", sub: "queue 32", read: "rnd4k_q32_read", write: "rnd4k_q32_write" },
  { label: "Random 4 KB", sub: "queue 1", read: "rnd4k_q1_read", write: "rnd4k_q1_write" },
];

interface StepInfo {
  state: StepState;
  message: string;
  percent: number | null;
  measurement: Measurement | null;
}

/** The volume on this drive with the most free space, if any. */
export function testVolume(drive: DriveReport): Volume | null {
  return [...drive.windows.volumes].sort((a, b) => (b.freeBytes ?? 0) - (a.freeBytes ?? 0))[0] ?? null;
}

/** Why the speed test can't run on this drive right now, or null if it can. */
export function speedTestBlocker(drive: DriveReport, selfTestRunning: boolean): string | null {
  const s = drive.smart;
  if (!drive.connected) return "This drive isn’t connected.";
  if (!s) return "SMARTCheck can’t read this drive’s health, so it won’t test its speed.";
  const vol = testVolume(drive);
  if (!vol) return "This drive has no drive letter, so there’s nowhere to put the test file.";
  if ((vol.freeBytes ?? 0) < MIN_FREE) return `${vol.letter}: needs at least 3 GB free for the temporary test file.`;
  const raw = (id: number) => s.attributes.find((a) => a.id === id)?.raw ?? 0;
  if (s.smartPassed === false || raw(197) + raw(198) > 0 || (s.nvme?.mediaErrors ?? 0) > 0)
    return "This drive has sectors it can’t read reliably. A speed test could stall on them and lock up the connection, so it’s not offered. Back up anything important first.";
  if (selfTestRunning || s.selfTestRemaining != null) return "A self-test is running on this drive. Wait for it to finish, or stop it, first.";
  return null;
}

const fmtMb = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

interface Props {
  drive: DriveReport;
  selfTestRunning: boolean;
  /** Browser preview only: start straight away (for screenshots). */
  autoStart?: boolean;
  onClose: () => void;
  onFinished: (run: SpeedRun) => void;
}

export function SpeedTestPanel({ drive, selfTestRunning, autoStart, onClose, onFinished }: Props) {
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [steps, setSteps] = useState<Record<string, StepInfo>>({});
  const [run, setRun] = useState<SpeedRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previous, setPrevious] = useState<SpeedRun | null>(null);
  const [stopping, setStopping] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const vol = testVolume(drive);
  const blocker = speedTestBlocker(drive, selfTestRunning);
  const usb = drive.windows.usb;

  useEffect(() => {
    getHistory(drive.key)
      .then((h) => {
        const complete = h.speedRuns.filter((r) => r.results.length > 0);
        setPrevious(complete[complete.length - 1] ?? null);
      })
      .catch(() => setPrevious(null));
  }, [drive.key]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && phase !== "running" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, phase]);

  const start = () => {
    if (!vol || !drive.smart) return;
    setPhase("running");
    setSteps({});
    setRun(null);
    setError(null);
    setStopping(false);
    const onProgress = (p: SpeedProgress) =>
      setSteps((prev) => ({ ...prev, [p.step]: { state: p.state, message: p.message, percent: p.percent, measurement: p.measurement ?? prev[p.step]?.measurement ?? null } }));
    startSpeedTest(
      { key: drive.key, deviceName: drive.smart.deviceName, deviceType: drive.smart.deviceType, volume: vol.letter, usbLink: usb?.link ?? null },
      onProgress,
    )
      .then((r) => {
        setRun(r);
        onFinished(r);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setPhase("done"));
  };

  const stop = () => {
    setStopping(true);
    cancelSpeedTest();
  };

  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStart && !blocker && !autoStarted.current) {
      autoStarted.current = true;
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  const prevById = useMemo(() => new Map(previous?.results.map((m) => [m.id, m]) ?? []), [previous]);
  const stepFor = (id: string): StepInfo => steps[id] ?? { state: "pending", message: "", percent: null, measurement: null };

  const cell = (id: string, random: boolean) => {
    const st = stepFor(id);
    const prev = prevById.get(id);
    let main: React.ReactNode = <span className="muted">—</span>;
    if (st.state === "running") main = <span className="cell-running">measuring…</span>;
    else if (st.state === "failed") main = <span className="cell-failed">stopped</span>;
    else if (st.measurement) main = <b>{fmtMb(st.measurement.mbPerS)}</b>;
    return (
      <td className="num">
        {main}
        {st.measurement && random && <div className="sub">{Math.round(st.measurement.iops).toLocaleString()} IOPS</div>}
        {prev && <div className="sub">last time {fmtMb(prev.mbPerS)}</div>}
      </td>
    );
  };

  const cleanup = stepFor("cleanup");

  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && phase !== "running" && onClose()}>
      <section className="modal speed" role="dialog" aria-modal="true" aria-label={`Speed test, ${drive.title}`}>
        <header className="panel-head">
          <div>
            <h2>Speed test</h2>
            <span className="sub">
              {drive.title}
              {vol ? ` · test file on ${vol.letter}: (${fmtBytes(vol.freeBytes)} free)` : ""}
            </span>
          </div>
          <button className="icon-btn" ref={closeRef} onClick={onClose} disabled={phase === "running"} aria-label="Close speed test">
            <CloseIcon />
          </button>
        </header>

        <div className="speed-body">
          {phase === "idle" && (
            <div className="speed-intro">
              <p>
                Measures how fast this drive reads and writes, the same way as CrystalDiskMark. SMARTCheck writes a temporary 1&nbsp;GB file
                {vol ? ` to ${vol.letter}:` : ""}, runs eight short tests (about 1–2 minutes), then deletes the file. Your files aren’t touched.
              </p>
              <p>If Windows reports a USB reset or a disk error at any point, the test stops straight away.</p>
              {usb?.link === "usb2" && (
                <p className="note-warn">
                  <StatusIcon level="warning" size={14} /> This drive is on a USB 2.0 connection, so results will be limited to about 40&nbsp;MB/s.
                </p>
              )}
              {previous && <p className="muted">Last tested {fmtDateTime(previous.atMs)}. Results will be shown side by side.</p>}
              {blocker && (
                <div className="banner warning">
                  <StatusIcon level="warning" />
                  <span>{blocker}</span>
                </div>
              )}
            </div>
          )}

          {phase !== "idle" && (
            <div className="speed-grid">
              <ol className="steps">
                {CHECKS.map((c) => {
                  const st = stepFor(c.id);
                  return (
                    <li key={c.id} className={st.state}>
                      <StepIcon state={st.state} />
                      <div>
                        <span>{c.label}</span>
                        {st.message && st.state !== "running" && <small>{st.message}</small>}
                        {c.id === "prepare" && st.state === "running" && st.percent != null && (
                          <div className="meter thin">
                            <span style={{ width: `${st.percent}%` }} />
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
                <li className={stepState(ROWS.flatMap((r) => [r.read, r.write]).map((id) => stepFor(id).state))}>
                  <StepIcon state={stepState(ROWS.flatMap((r) => [r.read, r.write]).map((id) => stepFor(id).state))} />
                  <div>
                    <span>Eight speed tests</span>
                    <small>5 seconds each</small>
                  </div>
                </li>
                <li className={cleanup.state}>
                  <StepIcon state={cleanup.state} />
                  <div>
                    <span>Delete the test file</span>
                    {cleanup.message && cleanup.state !== "running" && <small>{cleanup.message}</small>}
                  </div>
                </li>
              </ol>

              <table className="tbl results">
                <thead>
                  <tr>
                    <th>Test</th>
                    <th className="num">Read MB/s</th>
                    <th className="num">Write MB/s</th>
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((r) => (
                    <tr key={r.read}>
                      <td>
                        {r.label}
                        <div className="sub">{r.sub}</div>
                      </td>
                      {cell(r.read, r.label.startsWith("Random"))}
                      {cell(r.write, r.label.startsWith("Random"))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {error && (
            <div className="banner critical">
              <StatusIcon level="critical" />
              <span>{error}</span>
            </div>
          )}
          {run?.stopped && (
            <div className="banner warning">
              <StatusIcon level="warning" />
              <span>{run.stopped}</span>
            </div>
          )}
          {phase === "done" && run && !run.stopped && (
            <p className="muted">
              Random results on hard drives vary from run to run. Sequential results are the ones to compare.
            </p>
          )}
        </div>

        <footer className="modal-foot">
          {phase === "running" ? (
            <>
              <span className="muted watch">
                <i className="dot" /> Watching for USB resets and disk errors
              </span>
              <button className="btn" onClick={stop} disabled={stopping}>
                {stopping ? "Stopping…" : "Stop"}
              </button>
            </>
          ) : (
            <>
              <button className="btn ghost" onClick={onClose}>
                {phase === "done" ? "Close" : "Cancel"}
              </button>
              <button className="btn primary" onClick={start} disabled={!!blocker}>
                {phase === "done" ? "Run again" : "Start speed test"}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function stepState(states: StepState[]): StepState {
  if (states.some((s) => s === "failed")) return "failed";
  if (states.some((s) => s === "running")) return "running";
  if (states.every((s) => s === "done")) return "done";
  if (states.every((s) => s === "skipped")) return "skipped";
  if (states.some((s) => s === "done")) return "running";
  return "pending";
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <StatusIcon level="good" size={16} />;
  if (state === "failed") return <StatusIcon level="critical" size={16} />;
  if (state === "running") return <span className="step-spin" aria-label="In progress" />;
  return <span className={`step-dot ${state}`} aria-hidden />;
}

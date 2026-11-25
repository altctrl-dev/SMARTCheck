import { useCallback, useEffect, useRef, useState } from "react";
import type { DriveReport } from "../types";
import { abortSelfTest, selfTestStatus, startSelfTest } from "../api";

const POLL_MS = 5_000;

export interface SelfTestState {
  running: boolean;
  remaining: number | null;
  kind: "short" | "long" | null;
  error: string | null;
  busy: boolean;
  start: (kind: "short" | "long") => void;
  stop: () => void;
}

/**
 * Tracks a self-test on `drive`: picks up one already running (e.g. started before the app
 * opened), polls its progress, and calls `onFinished` when it ends so the results get re-read.
 */
export function useSelfTest(drive: DriveReport, onFinished: () => void): SelfTestState {
  const s = drive.smart;
  const [running, setRunning] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [kind, setKind] = useState<"short" | "long" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => {
    const already = s?.selfTestRemaining != null && drive.connected;
    setRunning(already);
    setRemaining(already ? s!.selfTestRemaining : null);
    setError(null);
  }, [drive.key, drive.connected, s?.selfTestRemaining, s]);

  useEffect(() => {
    if (!running || !s) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const st = await selfTestStatus(s.deviceName, s.deviceType);
        if (stopped) return;
        if (st.running) {
          setRemaining(st.remainingPercent);
        } else {
          setRunning(false);
          setRemaining(null);
          finished.current();
        }
      } catch (e) {
        if (!stopped) setError(String(e));
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [running, s]);

  const start = useCallback(
    (k: "short" | "long") => {
      if (!s) return;
      setBusy(true);
      setError(null);
      startSelfTest(drive.key, s.deviceName, s.deviceType, k)
        .then(() => {
          setKind(k);
          setRemaining(100);
          setRunning(true);
        })
        .catch((e) => setError(String(e)))
        .finally(() => setBusy(false));
    },
    [drive.key, s],
  );

  const stop = useCallback(() => {
    if (!s) return;
    setBusy(true);
    abortSelfTest(drive.key, s.deviceName, s.deviceType)
      .then(() => {
        setRunning(false);
        setRemaining(null);
        finished.current();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }, [drive.key, s]);

  return { running, remaining, kind, error, busy, start, stop };
}

function minutesLabel(min: number | null | undefined): string {
  if (min == null) return "";
  if (min < 90) return `about ${min} min`;
  return `about ${Math.round(min / 60)} hours`;
}

export function SelfTestMenu({ drive, st, disabled }: { drive: DriveReport; st: SelfTestState; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  if (st.running) {
    return (
      <button className="btn" onClick={st.stop} disabled={st.busy}>
        Stop self-test
      </button>
    );
  }
  const s = drive.smart;
  const pick = (k: "short" | "long") => {
    setOpen(false);
    st.start(k);
  };
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} disabled={disabled || st.busy}>
        Self-test <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => pick("short")}>
            <b>Short test</b>
            <span>Checks the main components · {minutesLabel(s?.selfTestMinutesShort ?? 2)}</span>
          </button>
          <button role="menuitem" onClick={() => pick("long")}>
            <b>Extended test</b>
            <span>Reads every sector · {minutesLabel(s?.selfTestMinutesExtended) || "can take hours"}</span>
          </button>
          <p className="menu-note">Runs inside the drive and only reads. Keep it connected and the PC awake until it finishes.</p>
        </div>
      )}
    </div>
  );
}

export function SelfTestStrip({ drive, st }: { drive: DriveReport; st: SelfTestState }) {
  if (!st.running && !st.error) return null;
  if (!st.running && st.error) {
    return (
      <div className="banner critical">
        <span>{st.error}</span>
      </div>
    );
  }
  const s = drive.smart;
  const total = st.kind === "short" ? s?.selfTestMinutesShort : st.kind === "long" ? s?.selfTestMinutesExtended : null;
  const done = st.remaining != null ? 100 - st.remaining : 0;
  const left = total != null && st.remaining != null ? Math.max(1, Math.round((total * st.remaining) / 100)) : null;
  const name = st.kind === "short" ? "Short self-test" : st.kind === "long" ? "Extended self-test" : "Self-test";
  return (
    <div className="selftest-strip" role="status">
      <div className="st-text">
        <b>{name} running</b>
        <span>
          {st.remaining != null ? `${st.remaining}% left` : "In progress"}
          {left != null ? ` · ${minutesLabel(left)} to go` : ""} · the drive is checking itself; keep it connected
        </span>
      </div>
      <div className="meter st-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={done}>
        <span style={{ width: `${Math.max(3, done)}%` }} />
      </div>
      {st.error && <span className="st-error">{st.error}</span>}
    </div>
  );
}

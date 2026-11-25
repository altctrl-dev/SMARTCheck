// Browser preview only (the desktop app talks to the Rust core instead).
// Readings come from real drives checked on 25 Nov 2026; the speed numbers are SMARTCheck's own
// measurements of the Seagate ST1000LM035 over USB 3. Self-tests are simulated, much faster than real.
import type { DriveHistory, DriveReport, Measurement, ScanResult, SelfTestStatus, Snapshot, SpeedProgress, SpeedRequest, SpeedRun } from "../types";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SEAGATE_USB3: Measurement[] = [
  { id: "seq1m_q8_read", label: "Sequential 1 MB, queue 8", write: false, mbPerS: 140.93, iops: 134.4, avgLatencyMs: 59.5 },
  { id: "seq1m_q1_read", label: "Sequential 1 MB, queue 1", write: false, mbPerS: 142.19, iops: 135.6, avgLatencyMs: 7.4 },
  { id: "rnd4k_q32_read", label: "Random 4 KB, queue 32", write: false, mbPerS: 1.46, iops: 356.4, avgLatencyMs: 89.8 },
  { id: "rnd4k_q1_read", label: "Random 4 KB, queue 1", write: false, mbPerS: 0.52, iops: 127.0, avgLatencyMs: 7.9 },
  { id: "seq1m_q8_write", label: "Sequential 1 MB, queue 8", write: true, mbPerS: 142.4, iops: 135.8, avgLatencyMs: 58.9 },
  { id: "seq1m_q1_write", label: "Sequential 1 MB, queue 1", write: true, mbPerS: 139.46, iops: 133.0, avgLatencyMs: 7.5 },
  { id: "rnd4k_q32_write", label: "Random 4 KB, queue 32", write: true, mbPerS: 1.1, iops: 268.6, avgLatencyMs: 119.1 },
  { id: "rnd4k_q1_write", label: "Random 4 KB, queue 1", write: true, mbPerS: 0.76, iops: 185.5, avgLatencyMs: 5.4 },
];

export async function scanDrives(): Promise<ScanResult> {
  const mock = await import("./scan.json");
  await delay(350);
  return structuredClone(mock.default) as unknown as ScanResult;
}

function snapshotOf(d: DriveReport): Snapshot | null {
  if (!d.smart || !d.health) return null;
  const raw = (id: number) => d.smart!.attributes.find((a) => a.id === id)?.raw ?? 0;
  return {
    atMs: d.checkedAtMs,
    score: d.health.score,
    status: d.health.status,
    reallocated: raw(5),
    pending: raw(197),
    uncorrectable: raw(198),
    errorLog: d.smart.errorLogCount,
    mediaErrors: d.smart.nvme?.mediaErrors ?? 0,
    percentageUsed: d.smart.nvme?.percentageUsed ?? null,
    temperature: d.smart.temperature,
    powerOnHours: d.smart.powerOnHours,
  };
}

export async function getHistory(key: string): Promise<DriveHistory> {
  const scan = await scanDrives();
  const d = [...scan.drives, ...scan.offline].find((x) => x.key === key);
  const snap = d ? snapshotOf(d) : null;
  const speedRuns: SpeedRun[] =
    key === "TESTSEAGATE1" ? [{ atMs: 1_795_591_800_000, volume: "G", link: "usb3", results: SEAGATE_USB3, stopped: null }] : [];
  return { snapshots: snap ? [snap] : [], speedRuns };
}

let selfTest: { started: number; durationMs: number } | null = null;

export async function startSelfTest(_key: string, kind: "short" | "long"): Promise<void> {
  await delay(300);
  selfTest = { started: Date.now(), durationMs: kind === "short" ? 15_000 : 40_000 };
}

export async function selfTestStatus(): Promise<SelfTestStatus> {
  await delay(150);
  if (!selfTest) return { running: false, remainingPercent: null, status: "completed without error" };
  const left = 1 - (Date.now() - selfTest.started) / selfTest.durationMs;
  if (left <= 0) {
    selfTest = null;
    return { running: false, remainingPercent: null, status: "completed without error" };
  }
  return { running: true, remainingPercent: Math.ceil(left * 10) * 10, status: "in progress" };
}

export async function abortSelfTest(): Promise<void> {
  await delay(200);
  selfTest = null;
}

let speedCancelled = false;

export async function startSpeedTest(req: SpeedRequest, onProgress: (p: SpeedProgress) => void): Promise<SpeedRun> {
  speedCancelled = false;
  const step = async (id: string, message: string, ms: number) => {
    onProgress({ step: id, state: "running", message, percent: null, measurement: null });
    await delay(ms);
    onProgress({ step: id, state: "done", message, percent: null, measurement: null });
  };
  await step("identity", `Serial ${req.key} confirmed`, 400);
  await step("space", `921 GB free on ${req.volume}:`, 250);
  await step("health", "No problem sectors", 400);
  for (let pct = 0; pct <= 100; pct += 10) {
    onProgress({ step: "prepare", state: pct === 100 ? "done" : "running", message: pct === 100 ? "Test file ready" : "Writing a 1 GB test file", percent: pct, measurement: null });
    await delay(120);
  }
  const results: Measurement[] = [];
  let stopped: string | null = null;
  for (const m of SEAGATE_USB3) {
    if (speedCancelled) {
      stopped = "Stopped.";
      onProgress({ step: m.id, state: "skipped", message: "", percent: null, measurement: null });
      continue;
    }
    onProgress({ step: m.id, state: "running", message: m.label, percent: null, measurement: null });
    await delay(450);
    results.push(m);
    onProgress({ step: m.id, state: "done", message: m.label, percent: null, measurement: m });
  }
  await step("cleanup", "Test file deleted", 250);
  return { atMs: Date.now(), volume: req.volume, link: req.usbLink, results, stopped };
}

export async function cancelSpeedTest(): Promise<void> {
  speedCancelled = true;
}

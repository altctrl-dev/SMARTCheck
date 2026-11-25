import type { DriveReport, HealthStatus, Level } from "./types";

export const fmtNum = (n: number) => n.toLocaleString("en-US");

/** Decimal units, matching how drive makers label capacity. */
export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtHours(h: number | null | undefined): string {
  if (h == null) return "—";
  if (h < 48) return `${fmtNum(h)} ${h === 1 ? "hour" : "hours"}`;
  const days = Math.round(h / 24);
  if (days < 730) return `${fmtNum(h)} hours (${fmtNum(days)} days)`;
  return `${fmtNum(h)} hours (${(h / 8766).toFixed(1)} years)`;
}

export const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** "26 Nov", for daily chart ticks. */
export const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** "26 Nov, 18:00" style, for chart axes spanning more than a day. */
export const fmtDayTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const fmtDateTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export const STATUS: Record<HealthStatus, { label: string; level: Level }> = {
  excellent: { label: "Excellent", level: "good" },
  good: { label: "Good", level: "good" },
  fair: { label: "Fair", level: "warning" },
  caution: { label: "Caution", level: "warning" },
  poor: { label: "Poor", level: "critical" },
  failing: { label: "Failing", level: "critical" },
};

export function isExternal(d: DriveReport): boolean {
  return (d.windows.busType ?? "").toUpperCase() === "USB";
}

export function letters(d: DriveReport): string {
  return d.windows.volumes.map((v) => `${v.letter}:`).join(" ");
}

/** "D: · USB 3", "C: · Internal NVMe" */
export function driveSubtitle(d: DriveReport): string {
  const l = letters(d);
  let link: string;
  if (d.windows.usb) {
    link = d.windows.usb.link === "usb3" ? "USB 3" : d.windows.usb.link === "usb2" ? "USB 2.0" : "USB";
  } else {
    const bus = d.kind === "nvme" ? "NVMe" : d.windows.busType ?? "";
    link = `Internal ${bus}`.trim();
  }
  return l ? `${l} · ${link}` : link;
}

export function tempLevel(t: number | null | undefined, limit: number): Level {
  if (t == null) return "info";
  if (t > limit) return "critical";
  if (t >= limit - 5) return "warning";
  return "good";
}

// Mirrors src-tauri/src/model.rs (serialized in camelCase).

export type DriveKind = "hdd" | "ssd" | "nvme" | "unknown";
export type UsbLink = "usb3" | "usb2" | "unknown";
export type HealthStatus = "excellent" | "good" | "fair" | "caution" | "poor" | "failing";
export type Level = "good" | "info" | "warning" | "critical";

export interface ScanResult {
  scannedAtMs: number;
  elevated: boolean;
  smartctlVersion: string | null;
  drives: DriveReport[];
  /** Drives checked before that aren't connected now (their last saved report). */
  offline: DriveReport[];
  warnings: string[];
}

export interface DriveReport {
  diskNumber: number;
  key: string;
  checkedAtMs: number;
  /** False for a saved report of a drive that isn't connected now. */
  connected: boolean;
  title: string;
  capacityLabel: string;
  kind: DriveKind;
  windows: WinDisk;
  smart: SmartInfo | null;
  smartError: string | null;
  health: Health | null;
}

export interface Volume {
  letter: string;
  label: string | null;
  fileSystem: string | null;
  sizeBytes: number | null;
  freeBytes: number | null;
}

export interface UsbInfo {
  vendorId: string | null;
  productId: string | null;
  chip: string | null;
  link: UsbLink;
  port: string | null;
  driver: string | null;
}

export interface WinDisk {
  number: number;
  friendlyName: string | null;
  busType: string | null;
  mediaType: string | null;
  sizeBytes: number | null;
  isSystem: boolean;
  isBoot: boolean;
  volumes: Volume[];
  usb: UsbInfo | null;
}

export interface TempHistory {
  intervalMinutes: number;
  values: (number | null)[];
}

export interface AtaAttribute {
  id: number;
  name: string;
  value: number;
  worst: number;
  thresh: number;
  raw: number;
  rawString: string;
  prefail: boolean;
  whenFailed: string;
}

export interface ErrorEntry {
  number: number;
  lifetimeHours: number | null;
  lba: number | null;
  description: string;
}

export interface SelfTest {
  kind: string;
  status: string;
  passed: boolean | null;
  lifetimeHours: number | null;
  lbaFirstError: number | null;
}

export interface NvmeHealth {
  criticalWarning: number;
  availableSpare: number | null;
  availableSpareThreshold: number | null;
  percentageUsed: number | null;
  mediaErrors: number;
  errorLogEntries: number;
  unsafeShutdowns: number | null;
}

export interface SmartInfo {
  protocol: string;
  deviceType: string;
  deviceName: string;
  modelFamily: string | null;
  modelName: string | null;
  serial: string | null;
  firmware: string | null;
  capacityBytes: number | null;
  rotationRate: number | null;
  formFactor: string | null;
  sataVersion: string | null;
  linkSpeed: string | null;
  linkSpeedMax: string | null;
  trim: boolean | null;
  smr: boolean;
  smartPassed: boolean | null;
  powerOnHours: number | null;
  powerCycles: number | null;
  temperature: number | null;
  tempLifetimeMin: number | null;
  tempLifetimeMax: number | null;
  tempLimit: number | null;
  tempHistory: TempHistory | null;
  attributes: AtaAttribute[];
  errorLogCount: number;
  errorLog: ErrorEntry[];
  selfTests: SelfTest[];
  selfTestRemaining: number | null;
  selfTestMinutesShort: number | null;
  selfTestMinutesExtended: number | null;
  nvme: NvmeHealth | null;
  bytesWritten: number | null;
  bytesRead: number | null;
  messages: string[];
}

export interface Finding {
  level: Level;
  title: string;
  detail: string;
  action: string | null;
}

export interface Indicator {
  label: string;
  value: string;
  level: Level;
  help: string;
}

export interface Deduction {
  factor: string;
  rule: string;
  value: string;
  points: number;
}

export interface Health {
  score: number;
  status: HealthStatus;
  summary: string;
  findings: Finding[];
  indicators: Indicator[];
  deductions: Deduction[];
}

// ---------------------------------------------------------------- History, self-tests, speed

export interface Snapshot {
  atMs: number;
  score: number;
  status: HealthStatus;
  reallocated: number;
  pending: number;
  uncorrectable: number;
  errorLog: number;
  mediaErrors: number;
  percentageUsed: number | null;
  temperature: number | null;
  powerOnHours: number | null;
}

export interface Measurement {
  id: string;
  label: string;
  write: boolean;
  mbPerS: number;
  iops: number;
  avgLatencyMs: number;
}

export interface SpeedRun {
  atMs: number;
  volume: string;
  link: UsbLink | null;
  results: Measurement[];
  stopped: string | null;
}

export interface DriveHistory {
  snapshots: Snapshot[];
  speedRuns: SpeedRun[];
}

export interface SelfTestStatus {
  running: boolean;
  remainingPercent: number | null;
  status: string;
}

export type StepState = "pending" | "running" | "done" | "failed" | "skipped";

export interface SpeedProgress {
  step: string;
  state: Exclude<StepState, "pending">;
  message: string;
  percent: number | null;
  measurement: Measurement | null;
}

export interface SpeedRequest {
  key: string;
  deviceName: string;
  deviceType: string;
  volume: string;
  usbLink: UsbLink | null;
}

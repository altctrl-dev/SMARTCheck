import type { DriveHistory, ScanResult, SelfTestStatus, SpeedProgress, SpeedRequest, SpeedRun } from "./types";
import * as preview from "./mock/preview";
import pkg from "../package.json";

/** True inside the desktop app; false when the UI is opened in a browser for preview. */
export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

export async function scanDrives(): Promise<ScanResult> {
  return isDesktop ? invoke<ScanResult>("scan_drives") : preview.scanDrives();
}

export async function getHistory(key: string): Promise<DriveHistory> {
  return isDesktop ? invoke<DriveHistory>("get_history", { key }) : preview.getHistory(key);
}

export async function startSelfTest(key: string, deviceName: string, deviceType: string, kind: "short" | "long"): Promise<void> {
  return isDesktop ? invoke("start_self_test", { key, deviceName, deviceType, kind }) : preview.startSelfTest(key, kind);
}

export async function selfTestStatus(deviceName: string, deviceType: string): Promise<SelfTestStatus> {
  return isDesktop ? invoke<SelfTestStatus>("self_test_status", { deviceName, deviceType }) : preview.selfTestStatus();
}

export async function abortSelfTest(key: string, deviceName: string, deviceType: string): Promise<void> {
  return isDesktop ? invoke("abort_self_test", { key, deviceName, deviceType }) : preview.abortSelfTest();
}

/** Runs the speed test; `onProgress` receives each step as it happens. */
export async function startSpeedTest(request: SpeedRequest, onProgress: (p: SpeedProgress) => void): Promise<SpeedRun> {
  if (!isDesktop) return preview.startSpeedTest(request, onProgress);
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<SpeedProgress>("speed-progress", (e) => onProgress(e.payload));
  try {
    return await invoke<SpeedRun>("start_speed_test", { request });
  } finally {
    unlisten();
  }
}

export async function cancelSpeedTest(): Promise<void> {
  return isDesktop ? invoke("cancel_speed_test") : preview.cancelSpeedTest();
}

export async function appVersion(): Promise<string> {
  if (!isDesktop) return pkg.version;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

/** Asks where to save, then saves the report. Returns the saved path, or null if cancelled. */
export async function exportReport(html: string, format: "pdf" | "html", baseName: string): Promise<string | null> {
  if (!isDesktop) {
    // Browser preview: download the HTML, or open it with the print dialog for PDF.
    if (format === "html") {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      a.download = `${baseName}.html`;
      a.click();
      return a.download;
    }
    const w = window.open("", "_blank");
    w?.document.write(html);
    w?.document.close();
    w?.print();
    return null;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: `${baseName}.${format}`,
    filters: [{ name: format === "pdf" ? "PDF document" : "Web page", extensions: [format] }],
  });
  if (!path) return null;
  await invoke("export_report", { html, path, format });
  return path;
}

export async function showInFolder(path: string): Promise<void> {
  if (isDesktop) await invoke("show_in_folder", { path });
}

export async function restartAsAdmin(): Promise<void> {
  if (isDesktop) await invoke("restart_as_admin");
}

export async function openLink(url: string): Promise<void> {
  if (isDesktop) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

import type { ScanResult } from "./types";

/** True inside the desktop app; false when the UI is opened in a browser for preview. */
export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function scanDrives(): Promise<ScanResult> {
  if (isDesktop) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<ScanResult>("scan_drives");
  }
  // Browser preview: readings from 25 Nov 2026, generated from the engine's test fixtures.
  const mock = await import("./mock/scan.json");
  await new Promise((r) => setTimeout(r, 350));
  return mock.default as unknown as ScanResult;
}

export async function restartAsAdmin(): Promise<void> {
  if (!isDesktop) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("restart_as_admin");
}

export async function openLink(url: string): Promise<void> {
  if (isDesktop) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

// Checks for a newer release and tells the user once per version per run.
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api";
import { toast } from "../stores/ui";
import type { UpdateInfo } from "./types";

const notified = new Set<string>();

export function openRelease(info: UpdateInfo) {
  void openUrl(info.url);
}

/** Background check: silent on errors, toasts only when a new version is out. */
export async function checkForUpdates(): Promise<void> {
  let info: UpdateInfo;
  try {
    info = await api.updateCheck();
  } catch {
    return;
  }
  if (!info.available || notified.has(info.latest)) return;
  notified.add(info.latest);
  toast(`Termindo ${info.latest} is available (you have ${info.current}).`, "info", {
    sticky: true,
    action: { label: "Download", onClick: () => openRelease(info) },
  });
}

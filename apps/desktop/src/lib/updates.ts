// Update check and in-app install.
//
// - "auto" mode (Windows, macOS, Linux AppImage): tauri-plugin-updater reads `latest.json`
//   from the latest GitHub release, verifies the signature and installs. If that fails we
//   fall back to the plain release check below.
// - "manual" mode (Linux .deb/.rpm): only tell the user and open the release page.
//
// Nothing is ever installed without the user pressing "Update & restart".
import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api, errorMessage } from "./api";
import { confirmDialog, toast, useUi } from "../stores/ui";
import { useWorkspace } from "../stores/workspace";
import type { UpdateInfo, UpdateMode } from "./types";

const RELEASES_URL = "https://github.com/bionyxxx/termindo/releases";

/** Result of a check. `update` is set when it can be installed in-app. */
export interface UpdateFound {
  current: string;
  latest: string;
  available: boolean;
  notes: string | null;
  /** Release page, for a manual download. */
  url: string;
  update: Update | null;
}

export type InstallPhase = "idle" | "downloading" | "installing" | "restarting";

interface UpdateStore {
  mode: UpdateMode | null;
  found: UpdateFound | null;
  phase: InstallPhase;
  /** 0..1 while downloading, `null` when the size is unknown. */
  progress: number | null;
}

export const useUpdates = create<UpdateStore>(() => ({ mode: null, found: null, phase: "idle", progress: null }));

let modePromise: Promise<UpdateMode> | null = null;

export function updateMode(): Promise<UpdateMode> {
  modePromise ??= api
    .updateMode()
    .catch((): UpdateMode => "manual")
    .then((mode) => {
      useUpdates.setState({ mode });
      return mode;
    });
  return modePromise;
}

function fromInfo(info: UpdateInfo): UpdateFound {
  return { ...info, update: null };
}

function fromUpdate(update: Update): UpdateFound {
  return {
    current: update.currentVersion,
    latest: update.version,
    available: true,
    notes: update.body?.trim() || null,
    url: `${RELEASES_URL}/tag/v${update.version}`,
    update,
  };
}

/** Checks for a newer version and stores the result. Throws when no source could be reached. */
export async function findUpdate(): Promise<UpdateFound> {
  const mode = await updateMode();
  let found: UpdateFound | null = null;
  if (mode === "auto") {
    try {
      const update = await check();
      if (update) found = fromUpdate(update);
      else {
        const current = await getVersion();
        found = { current, latest: current, available: false, notes: null, url: RELEASES_URL, update: null };
      }
    } catch (e) {
      console.warn("updater check failed, falling back to the release API", e);
    }
  }
  found ??= fromInfo(await api.updateCheck());
  useUpdates.setState({ found });
  return found;
}

export function openRelease(found: { url: string }) {
  void openUrl(found.url);
}

const notified = new Set<string>();

/** Background check: silent on errors, toasts only when a new version is out. */
export async function checkForUpdates(): Promise<void> {
  let found: UpdateFound;
  try {
    found = await findUpdate();
  } catch {
    return;
  }
  if (!found.available || notified.has(found.latest)) return;
  notified.add(found.latest);
  const { update } = found;
  if (update) {
    toast(`Termindo ${found.latest} is available (you have ${found.current}).`, "info", {
      sticky: true,
      action: { label: "Update & restart", onClick: () => void installUpdate(update) },
    });
  } else {
    toast(`Termindo ${found.latest} is available (you have ${found.current}).`, "info", {
      sticky: true,
      action: { label: "Download", onClick: () => openRelease(found) },
    });
  }
}

/** Connected terminal panes plus open SFTP tabs. */
function activeSessionCount(): number {
  const ws = useWorkspace.getState();
  const panes = Object.values(ws.panes).filter((p) => p.status === "connected").length;
  const sftp = ws.tabs.filter((t) => t.kind === "sftp").length;
  return panes + sftp;
}

// Set synchronously so two clicks (toast + Settings) never start two downloads.
let installing = false;

export async function installUpdate(update: Update): Promise<void> {
  if (installing) return;
  installing = true;
  try {
    const live = activeSessionCount();
    if (
      live > 0 &&
      !(await confirmDialog({
        title: "Update and restart?",
        message: `${live} active session${live > 1 ? "s" : ""} will be disconnected when Termindo restarts.`,
        confirmLabel: "Update & restart",
        danger: true,
      }))
    )
      return;

    const label = `Termindo ${update.version}`;
    const toastId = toast(`Downloading ${label}…`, "info", { sticky: true });
    const setProgress = (phase: InstallPhase, progress: number | null, message: string) => {
      useUpdates.setState({ phase, progress });
      useUi.getState().updateToast(toastId, { message });
    };

    let total = 0;
    let done = 0;
    setProgress("downloading", null, `Downloading ${label}…`);
    try {
      await update.downloadAndInstall((e: DownloadEvent) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          done += e.data.chunkLength;
          const p = total > 0 ? Math.min(done / total, 1) : null;
          setProgress("downloading", p, `Downloading ${label}…${p === null ? "" : ` ${Math.round(p * 100)}%`}`);
        } else if (e.event === "Finished") setProgress("installing", 1, `Installing ${label}…`);
      });
      // On Windows the NSIS/MSI installer closes the app by itself before we get here.
      setProgress("restarting", 1, `Restarting into ${label}…`);
      await relaunch();
    } catch (e) {
      useUpdates.setState({ phase: "idle", progress: null });
      useUi.getState().dismissToast(toastId);
      toast(`Update failed: ${errorMessage(e)}`, "error", {
        sticky: true,
        action: { label: "Download", onClick: () => void openUrl(`${RELEASES_URL}/tag/v${update.version}`) },
      });
    }
  } finally {
    installing = false;
  }
}

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "./stores/app";
import { useData } from "./stores/data";
import { useSettings } from "./stores/settings";
import { toast, useUi } from "./stores/ui";
import { useTransfers } from "./stores/transfers";
import { findSession } from "./terminal/registry";
import { checkForUpdates } from "./lib/updates";
import type { PromptEvent, SyncStatus, TransferInfo } from "./lib/types";
import { LockScreen } from "./views/LockScreen";
import { Workspace } from "./views/Workspace";
import { PromptHost } from "./components/Prompts";
import { Toaster } from "./components/Toaster";

function useAppTheme() {
  const appTheme = useSettings((s) => s.settings.appTheme);
  useEffect(() => {
    const apply = () => {
      const dark = appTheme === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : appTheme === "dark";
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [appTheme]);
}

function useBackendEvents() {
  useEffect(() => {
    const unlisten = [
      listen<PromptEvent>("prompt", (e) => useUi.getState().pushBackendPrompt(e.payload)),
      listen<{ sessionId: string; exitStatus: number | null; userClosed: boolean }>("ssh-closed", (e) => {
        findSession(e.payload.sessionId)?.onClosed(e.payload.userClosed, e.payload.exitStatus);
      }),
      listen("data-changed", () => {
        if (useApp.getState().phase === "unlocked") void useData.getState().loadAll();
      }),
      listen<SyncStatus>("sync-status", () => void useApp.getState().refreshAccount()),
      listen<TransferInfo>("transfer-update", (e) => useTransfers.getState().upsert(e.payload)),
      listen<{ remotePath: string; ok: boolean; error: string | null }>("sftp-edit", (e) => {
        const name = e.payload.remotePath.split("/").pop();
        if (e.payload.ok) toast(`Uploaded ${name}`, "success");
        else toast(`Upload of ${name} failed: ${e.payload.error}`, "error");
      }),
    ];
    return () => unlisten.forEach((p) => void p.then((f) => f()));
  }, []);
}

function useAutoLock() {
  const minutes = useSettings((s) => s.settings.autoLockMinutes);
  const phase = useApp((s) => s.phase);
  useEffect(() => {
    if (!minutes || phase !== "unlocked") return;
    let last = Date.now();
    const bump = () => (last = Date.now());
    const events = ["keydown", "mousedown", "mousemove", "wheel"] as const;
    events.forEach((ev) => window.addEventListener(ev, bump, { passive: true }));
    const timer = setInterval(() => {
      if (Date.now() - last > minutes * 60_000) void useApp.getState().lock();
    }, 15_000);
    return () => {
      clearInterval(timer);
      events.forEach((ev) => window.removeEventListener(ev, bump));
    };
  }, [minutes, phase]);
}

/** Looks for a new release shortly after startup, then every few hours. */
function useUpdateCheck() {
  const loaded = useSettings((s) => s.loaded);
  const enabled = useSettings((s) => s.settings.checkUpdates);
  useEffect(() => {
    if (!loaded || !enabled) return;
    const first = setTimeout(() => void checkForUpdates(), 5_000);
    const every = setInterval(() => void checkForUpdates(), 6 * 60 * 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [loaded, enabled]);
}

export function App() {
  const phase = useApp((s) => s.phase);
  useAppTheme();
  useBackendEvents();
  useAutoLock();
  useUpdateCheck();

  useEffect(() => {
    void (async () => {
      await useSettings.getState().load();
      await useApp.getState().refreshVault();
      if (useApp.getState().phase === "unlocked") await useApp.getState().onUnlocked();
    })();
  }, []);

  return (
    <>
      {phase === "loading" ? (
        <div className="flex h-full items-center justify-center">
          <img src="/logo.svg" className="h-12 w-12 animate-pulse" alt="" />
        </div>
      ) : phase === "unlocked" ? (
        <Workspace />
      ) : (
        <LockScreen />
      )}
      <PromptHost />
      <Toaster />
    </>
  );
}

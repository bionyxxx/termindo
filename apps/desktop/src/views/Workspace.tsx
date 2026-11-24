import { useEffect, useState } from "react";
import {
  Server,
  Code2,
  KeyRound,
  ShieldCheck,
  History,
  Settings as SettingsIcon,
  Lock,
  Plus,
  X,
  Home,
  FolderOpen,
  Radio,
  Cloud,
  CloudOff,
  RefreshCw,
} from "lucide-react";
import { useApp } from "../stores/app";
import { useSettings } from "../stores/settings";
import { confirmDialog, promptInput, useUi, type View } from "../stores/ui";
import { HOME_TAB, layoutPaneIds, persistSession, restoreSession, useWorkspace, type Tab } from "../stores/workspace";
import { findSession, setShortcutFilter } from "../terminal/registry";
import { cn, isMac, timeAgo } from "../lib/utils";
import { api, errorMessage } from "../lib/api";
import { StatusDot } from "../components/ui";
import { HostsView } from "./HostsView";
import { SnippetsView } from "./SnippetsView";
import { KeychainView } from "./KeychainView";
import { KnownHostsView } from "./KnownHostsView";
import { HistoryView } from "./HistoryView";
import { SettingsView } from "./SettingsView";
import { TerminalTabView } from "../terminal/TerminalTabView";
import { SftpView } from "../sftp/SftpView";
import { CommandPalette } from "../components/CommandPalette";
import { SnippetPalette } from "../components/SnippetPalette";
import { toast } from "../stores/ui";

type Action =
  | "palette"
  | "closePane"
  | "splitRight"
  | "splitDown"
  | "nextTab"
  | "prevTab"
  | "search"
  | "snippets"
  | "fontUp"
  | "fontDown"
  | "fontReset"
  | "lock"
  | "left"
  | "right"
  | "up"
  | "down"
  | `tab${number}`;

function matchShortcut(e: KeyboardEvent): Action | null {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (e.ctrlKey && e.code === "Tab") return e.shiftKey ? "prevTab" : "nextTab";
  if (e.altKey && !mod && !e.shiftKey) {
    if (e.code === "ArrowLeft") return "left";
    if (e.code === "ArrowRight") return "right";
    if (e.code === "ArrowUp") return "up";
    if (e.code === "ArrowDown") return "down";
  }
  if (!mod) return null;
  if (!e.shiftKey && e.code === "KeyK") return "palette";
  if (e.shiftKey) {
    switch (e.code) {
      case "KeyT":
        return "palette";
      case "KeyW":
        return "closePane";
      case "KeyD":
        return "splitRight";
      case "KeyE":
        return "splitDown";
      case "KeyF":
        return "search";
      case "KeyS":
        return "snippets";
      case "KeyL":
        return "lock";
    }
  }
  if (!e.shiftKey && (e.code === "Equal" || e.code === "NumpadAdd")) return "fontUp";
  if (!e.shiftKey && (e.code === "Minus" || e.code === "NumpadSubtract")) return "fontDown";
  if (!e.shiftKey && e.code === "Digit0") return "fontReset";
  if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) return `tab${Number(e.code.slice(5))}`;
  return null;
}

export function activePaneId(): string | null {
  const ws = useWorkspace.getState();
  const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
  return tab && tab.kind === "terminal" ? tab.activePaneId : null;
}

async function closeTabWithConfirm(tab: Tab) {
  const ws = useWorkspace.getState();
  if (tab.kind === "terminal" && useSettings.getState().settings.confirmCloseTab) {
    const live = layoutPaneIds(tab.layout).filter((id) => ws.panes[id]?.status === "connected").length;
    if (live > 0) {
      const ok = await confirmDialog({
        title: "Close tab?",
        message: `${live} active session${live > 1 ? "s" : ""} will be disconnected.`,
        confirmLabel: "Close",
        danger: true,
      });
      if (!ok) return;
    }
  }
  ws.closeTab(tab.id);
}

function runAction(action: Action) {
  const ws = useWorkspace.getState();
  const ui = useUi.getState();
  const settings = useSettings.getState();
  const pane = activePaneId();
  switch (action) {
    case "palette":
      ui.setPaletteOpen(true);
      break;
    case "snippets":
      ui.setSnippetPaletteOpen(true);
      break;
    case "closePane":
      if (pane) ws.closePane(pane);
      else {
        const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
        if (tab) void closeTabWithConfirm(tab);
      }
      break;
    case "splitRight":
    case "splitDown":
      if (pane) ws.splitPane(pane, action === "splitRight" ? "horizontal" : "vertical");
      break;
    case "nextTab":
      ws.cycleTab(1);
      break;
    case "prevTab":
      ws.cycleTab(-1);
      break;
    case "search":
      if (pane) window.dispatchEvent(new CustomEvent("termindo:search", { detail: pane }));
      break;
    case "fontUp":
      settings.update({ fontSize: Math.min(32, settings.settings.fontSize + 1) });
      break;
    case "fontDown":
      settings.update({ fontSize: Math.max(8, settings.settings.fontSize - 1) });
      break;
    case "fontReset":
      settings.update({ fontSize: 14 });
      break;
    case "lock":
      void useApp.getState().lock();
      break;
    case "left":
    case "right":
    case "up":
    case "down":
      ws.focusNeighbor(action);
      break;
    default:
      if (action.startsWith("tab")) {
        const n = Number(action.slice(3));
        const ids = [HOME_TAB, ...ws.tabs.map((t) => t.id)];
        if (ids[n - 1]) ws.setActiveTab(ids[n - 1]);
      }
  }
}

function useShortcuts() {
  useEffect(() => {
    setShortcutFilter((e) => matchShortcut(e) !== null);
    const onKey = (e: KeyboardEvent) => {
      const action = matchShortcut(e);
      if (!action) return;
      // Inside regular inputs, only handle a few global ones.
      const target = e.target as HTMLElement | null;
      const inField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA") && !target.closest(".xterm");
      if (inField && !["palette", "nextTab", "prevTab", "lock"].includes(action)) return;
      e.preventDefault();
      e.stopPropagation();
      runAction(action);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

const NAV: { id: View; label: string; icon: typeof Server }[] = [
  { id: "hosts", label: "Hosts", icon: Server },
  { id: "snippets", label: "Snippets", icon: Code2 },
  { id: "keychain", label: "Keychain", icon: KeyRound },
  { id: "knownHosts", label: "Known hosts", icon: ShieldCheck },
  { id: "history", label: "History", icon: History },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

function SyncIndicator() {
  const account = useApp((s) => s.account);
  if (!account?.signedIn) return null;
  const st = account.status;
  return (
    <button
      title={st.lastError ?? `Synced ${timeAgo(account.lastSyncedAt)}`}
      onClick={() =>
        void api
          .syncNow()
          .then(() => useApp.getState().refreshAccount())
          .catch((e) => toast(errorMessage(e), "error"))
      }
      className="flex w-full flex-col items-center gap-0.5 rounded-md py-2 text-[10px] text-muted hover:bg-hover hover:text-fg"
    >
      {st.syncing ? (
        <RefreshCw size={17} className="animate-spin" />
      ) : st.lastError ? (
        <CloudOff size={17} className="text-danger" />
      ) : (
        <Cloud size={17} className="text-ok" />
      )}
      Sync
    </button>
  );
}

function Sidebar() {
  const { view, setView } = useUi();
  return (
    <nav className="flex w-[76px] shrink-0 flex-col items-stretch gap-1 border-r border-line bg-panel px-2 py-3">
      {NAV.map((n) => (
        <button
          key={n.id}
          onClick={() => setView(n.id)}
          className={cn(
            "flex flex-col items-center gap-1 rounded-md py-2 text-[10.5px] transition-colors",
            view === n.id ? "bg-accent/15 text-accent" : "text-muted hover:bg-hover hover:text-fg",
          )}
        >
          <n.icon size={18} />
          {n.label}
        </button>
      ))}
      <div className="flex-1" />
      <SyncIndicator />
      <button
        onClick={() => void useApp.getState().lock()}
        title={`Lock (${isMac ? "⌘" : "Ctrl"}+Shift+L)`}
        className="flex flex-col items-center gap-1 rounded-md py-2 text-[10.5px] text-muted hover:bg-hover hover:text-fg"
      >
        <Lock size={18} />
        Lock
      </button>
    </nav>
  );
}

function TabButton({ tab }: { tab: Tab }) {
  const { activeTabId, setActiveTab, moveTab, panes, renameTab } = useWorkspace();
  const [dragOver, setDragOver] = useState(false);
  const active = tab.id === activeTabId;
  const statuses = tab.kind === "terminal" ? layoutPaneIds(tab.layout).map((id) => panes[id]?.status ?? "closed") : [];
  const status = statuses.includes("connected")
    ? "connected"
    : statuses.includes("connecting")
      ? "connecting"
      : statuses.includes("error")
        ? "error"
        : "closed";
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData("termindo/tab", tab.id)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("termindo/tab")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const from = e.dataTransfer.getData("termindo/tab");
        if (from) moveTab(from, tab.id);
      }}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void closeTabWithConfirm(tab);
        }
      }}
      onClick={() => setActiveTab(tab.id)}
      onDoubleClick={() =>
        void promptInput({ title: "Rename tab", label: "Title", defaultValue: tab.title }).then((title) => {
          if (title) renameTab(tab.id, title);
        })
      }
      className={cn(
        "group relative flex h-full max-w-[220px] min-w-[120px] cursor-default items-center gap-2 border-r border-line px-3 text-[12.5px]",
        active ? "bg-bg text-fg" : "text-muted hover:bg-hover hover:text-fg",
        dragOver && "bg-accent/10",
      )}
    >
      {active && <span className="absolute inset-x-0 top-0 h-[2px]" style={{ background: tab.color || "var(--app-accent)" }} />}
      {tab.kind === "sftp" ? <FolderOpen size={13} className="shrink-0 text-accent" /> : <StatusDot status={status} />}
      <span className="truncate">{tab.title}</span>
      {tab.kind === "terminal" && tab.broadcast && <Radio size={12} className="shrink-0 text-warn" />}
      <button
        className="ml-auto rounded p-0.5 opacity-0 hover:bg-hover group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          void closeTabWithConfirm(tab);
        }}
      >
        <X size={13} />
      </button>
    </div>
  );
}

function TabBar() {
  const { tabs, activeTabId, setActiveTab } = useWorkspace();
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-panel">
      <button
        onClick={() => setActiveTab(HOME_TAB)}
        className={cn(
          "flex w-[76px] shrink-0 items-center justify-center gap-1.5 border-r border-line text-[12px]",
          activeTabId === HOME_TAB ? "bg-bg text-accent" : "text-muted hover:bg-hover hover:text-fg",
        )}
        title="Vault"
      >
        <Home size={14} />
      </button>
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {tabs.map((t) => (
          <TabButton key={t.id} tab={t} />
        ))}
        <button
          className="flex w-9 shrink-0 items-center justify-center text-muted hover:bg-hover hover:text-fg"
          title={`New connection (${isMac ? "⌘" : "Ctrl"}+K)`}
          onClick={() => setPaletteOpen(true)}
        >
          <Plus size={15} />
        </button>
      </div>
    </div>
  );
}

function HomeView() {
  const view = useUi((s) => s.view);
  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto bg-bg">
        {view === "hosts" && <HostsView />}
        {view === "snippets" && <SnippetsView />}
        {view === "keychain" && <KeychainView />}
        {view === "knownHosts" && <KnownHostsView />}
        {view === "history" && <HistoryView />}
        {view === "settings" && <SettingsView />}
      </main>
    </div>
  );
}

export function Workspace() {
  const { tabs, activeTabId } = useWorkspace();
  const restore = useSettings((s) => s.settings.restoreSession);
  useShortcuts();

  // Restore the previous session once, then persist changes.
  useEffect(() => {
    let unsub: (() => void) | undefined;
    void (async () => {
      if (restore && useWorkspace.getState().tabs.length === 0) await restoreSession();
      unsub = useWorkspace.subscribe((s, prev) => {
        if (s.tabs !== prev.tabs) persistSession();
      });
    })();
    return () => unsub?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the active terminal when switching tabs.
  useEffect(() => {
    const id = activePaneId();
    if (id) requestAnimationFrame(() => findSession(id)?.focus());
  }, [activeTabId]);

  return (
    <div className="flex h-full flex-col">
      <TabBar />
      <div className="relative flex min-h-0 flex-1">
        <div className={cn("absolute inset-0 flex", activeTabId !== HOME_TAB && "hidden")}>
          <HomeView />
        </div>
        {tabs.map((t) => (
          <div key={t.id} className={cn("absolute inset-0 flex", t.id !== activeTabId && "hidden")}>
            {t.kind === "terminal" ? <TerminalTabView tab={t} /> : <SftpView tab={t} />}
          </div>
        ))}
      </div>
      <CommandPalette />
      <SnippetPalette />
    </div>
  );
}

// Tabs, split layouts and pane status.
import { create } from "zustand";
import { api } from "../lib/api";
import type { ConnectTarget } from "../lib/types";
import { debounce, uid } from "../lib/utils";

export type PaneStatus = "connecting" | "connected" | "closed" | "error";
export type Orientation = "horizontal" | "vertical";

export interface Pane {
  id: string;
  tabId: string;
  title: string;
  /** Saved without one-off passwords. */
  target: ConnectTarget;
  status: PaneStatus;
  error?: string;
  color?: string;
}

export type LayoutNode =
  | { type: "pane"; paneId: string }
  | { type: "split"; id: string; orientation: Orientation; children: LayoutNode[] };

export interface TerminalTab {
  id: string;
  kind: "terminal";
  title: string;
  layout: LayoutNode;
  activePaneId: string;
  broadcast: boolean;
  color?: string;
}

export interface SftpTab {
  id: string;
  kind: "sftp";
  title: string;
  target: ConnectTarget;
  color?: string;
}

export type Tab = TerminalTab | SftpTab;

export const HOME_TAB = "home";

interface WorkspaceStore {
  tabs: Tab[];
  activeTabId: string;
  panes: Record<string, Pane>;
  openTerminal: (target: ConnectTarget, title: string, color?: string) => string;
  openSftp: (target: ConnectTarget, title: string, color?: string) => string;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  closePane: (paneId: string) => void;
  splitPane: (paneId: string, orientation: Orientation) => string | null;
  focusPane: (paneId: string) => void;
  focusNeighbor: (dir: "left" | "right" | "up" | "down") => void;
  setPaneStatus: (paneId: string, status: PaneStatus, error?: string) => void;
  moveTab: (fromId: string, toId: string) => void;
  renameTab: (id: string, title: string) => void;
  toggleBroadcast: (tabId: string) => void;
  cycleTab: (delta: number) => void;
  /** Tab ids of terminal panes, for "run on all sessions". */
  paneIdsOfTab: (tabId: string) => string[];
}

export function layoutPaneIds(node: LayoutNode): string[] {
  return node.type === "pane" ? [node.paneId] : node.children.flatMap(layoutPaneIds);
}

function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === "pane") return node.paneId === paneId ? null : node;
  const children = node.children.map((c) => removePane(c, paneId)).filter((c): c is LayoutNode => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children };
}

function insertSplit(node: LayoutNode, paneId: string, newPaneId: string, orientation: Orientation): LayoutNode {
  if (node.type === "pane") {
    if (node.paneId !== paneId) return node;
    return {
      type: "split",
      id: uid(),
      orientation,
      children: [node, { type: "pane", paneId: newPaneId }],
    };
  }
  // Same orientation: add a sibling instead of nesting.
  const idx = node.children.findIndex((c) => c.type === "pane" && c.paneId === paneId);
  if (idx >= 0 && node.orientation === orientation) {
    const children = [...node.children];
    children.splice(idx + 1, 0, { type: "pane", paneId: newPaneId });
    return { ...node, children };
  }
  return { ...node, children: node.children.map((c) => insertSplit(c, paneId, newPaneId, orientation)) };
}

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  tabs: [],
  activeTabId: HOME_TAB,
  panes: {},

  openTerminal: (target, title, color) => {
    const tabId = uid();
    const paneId = uid();
    const tab: TerminalTab = {
      id: tabId,
      kind: "terminal",
      title,
      layout: { type: "pane", paneId },
      activePaneId: paneId,
      broadcast: false,
      color,
    };
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tabId,
      panes: { ...s.panes, [paneId]: { id: paneId, tabId, title, target, status: "connecting", color } },
    }));
    return tabId;
  },

  openSftp: (target, title, color) => {
    const tabId = uid();
    set((s) => ({ tabs: [...s.tabs, { id: tabId, kind: "sftp", title, target, color }], activeTabId: tabId }));
    return tabId;
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  closeTab: (id) => {
    const s = get();
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab) return;
    const idx = s.tabs.indexOf(tab);
    const tabs = s.tabs.filter((t) => t.id !== id);
    const panes = { ...s.panes };
    if (tab.kind === "terminal") for (const p of layoutPaneIds(tab.layout)) delete panes[p];
    const activeTabId =
      s.activeTabId === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? HOME_TAB) : s.activeTabId;
    set({ tabs, panes, activeTabId });
  },

  closePane: (paneId) => {
    const s = get();
    const pane = s.panes[paneId];
    if (!pane) return;
    const tab = s.tabs.find((t) => t.id === pane.tabId);
    if (!tab || tab.kind !== "terminal") return;
    const layout = removePane(tab.layout, paneId);
    if (!layout) {
      get().closeTab(tab.id);
      return;
    }
    const panes = { ...s.panes };
    delete panes[paneId];
    const remaining = layoutPaneIds(layout);
    const activePaneId = tab.activePaneId === paneId ? remaining[0] : tab.activePaneId;
    set({
      panes,
      tabs: s.tabs.map((t) => (t.id === tab.id ? { ...tab, layout, activePaneId } : t)),
    });
  },

  splitPane: (paneId, orientation) => {
    const s = get();
    const pane = s.panes[paneId];
    if (!pane) return null;
    const tab = s.tabs.find((t) => t.id === pane.tabId);
    if (!tab || tab.kind !== "terminal") return null;
    const newId = uid();
    set({
      panes: { ...s.panes, [newId]: { ...pane, id: newId, status: "connecting", error: undefined } },
      tabs: s.tabs.map((t) =>
        t.id === tab.id ? { ...tab, layout: insertSplit(tab.layout, paneId, newId, orientation), activePaneId: newId } : t,
      ),
    });
    return newId;
  },

  focusPane: (paneId) => {
    const pane = get().panes[paneId];
    if (!pane) return;
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === pane.tabId && t.kind === "terminal" ? { ...t, activePaneId: paneId } : t)),
    }));
  },

  focusNeighbor: (dir) => {
    const s = get();
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    if (!tab || tab.kind !== "terminal") return;
    // Geometric navigation using the rendered pane rectangles.
    const cur = document.querySelector<HTMLElement>(`[data-pane-id="${tab.activePaneId}"]`)?.getBoundingClientRect();
    if (!cur) return;
    let best: { id: string; d: number } | null = null;
    for (const id of layoutPaneIds(tab.layout)) {
      if (id === tab.activePaneId) continue;
      const r = document.querySelector<HTMLElement>(`[data-pane-id="${id}"]`)?.getBoundingClientRect();
      if (!r) continue;
      const dx = r.left + r.width / 2 - (cur.left + cur.width / 2);
      const dy = r.top + r.height / 2 - (cur.top + cur.height / 2);
      const ok =
        (dir === "left" && dx < -1) || (dir === "right" && dx > 1) || (dir === "up" && dy < -1) || (dir === "down" && dy > 1);
      if (!ok) continue;
      const d = Math.abs(dx) + Math.abs(dy);
      if (!best || d < best.d) best = { id, d };
    }
    if (best) get().focusPane(best.id);
  },

  setPaneStatus: (paneId, status, error) =>
    set((s) => (s.panes[paneId] ? { panes: { ...s.panes, [paneId]: { ...s.panes[paneId], status, error } } } : {})),

  moveTab: (fromId, toId) =>
    set((s) => {
      const tabs = [...s.tabs];
      const from = tabs.findIndex((t) => t.id === fromId);
      const to = tabs.findIndex((t) => t.id === toId);
      if (from < 0 || to < 0 || from === to) return {};
      const [t] = tabs.splice(from, 1);
      tabs.splice(to, 0, t);
      return { tabs };
    }),

  renameTab: (id, title) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) })),

  toggleBroadcast: (tabId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId && t.kind === "terminal" ? { ...t, broadcast: !t.broadcast } : t)),
    })),

  cycleTab: (delta) => {
    const s = get();
    const ids = [HOME_TAB, ...s.tabs.map((t) => t.id)];
    const i = ids.indexOf(s.activeTabId);
    set({ activeTabId: ids[(i + delta + ids.length) % ids.length] });
  },

  paneIdsOfTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    return tab && tab.kind === "terminal" ? layoutPaneIds(tab.layout) : [];
  },
}));

// -- session persistence ------------------------------------------------------------

interface SavedTab {
  kind: "terminal" | "sftp";
  title: string;
  color?: string;
  target?: ConnectTarget;
  layout?: SavedLayout;
}
type SavedLayout = { type: "pane"; target: ConnectTarget; title: string } | { type: "split"; orientation: Orientation; children: SavedLayout[] };

function stripTarget(t: ConnectTarget): ConnectTarget {
  return { hostId: t.hostId ?? null, quick: t.quick ?? null };
}

function saveLayout(node: LayoutNode, panes: Record<string, Pane>): SavedLayout | null {
  if (node.type === "pane") {
    const p = panes[node.paneId];
    return p ? { type: "pane", target: stripTarget(p.target), title: p.title } : null;
  }
  const children = node.children.map((c) => saveLayout(c, panes)).filter((c): c is SavedLayout => !!c);
  return children.length ? { type: "split", orientation: node.orientation, children } : null;
}

export const persistSession = debounce(() => {
  const { tabs, panes } = useWorkspace.getState();
  const saved: SavedTab[] = tabs
    .map((t): SavedTab | null => {
      if (t.kind === "sftp") return { kind: "sftp", title: t.title, color: t.color, target: stripTarget(t.target) };
      const layout = saveLayout(t.layout, panes);
      return layout ? { kind: "terminal", title: t.title, color: t.color, layout } : null;
    })
    .filter((t): t is SavedTab => !!t);
  void api.settingSet("session", JSON.stringify(saved));
}, 1000);

export async function restoreSession(): Promise<number> {
  const raw = await api.settingGet("session");
  if (!raw) return 0;
  let saved: SavedTab[];
  try {
    saved = JSON.parse(raw);
  } catch {
    return 0;
  }
  const tabs: Tab[] = [];
  const panes: Record<string, Pane> = {};
  for (const st of saved) {
    const tabId = uid();
    if (st.kind === "sftp" && st.target) {
      tabs.push({ id: tabId, kind: "sftp", title: st.title, target: st.target, color: st.color });
      continue;
    }
    if (!st.layout) continue;
    const build = (n: SavedLayout): LayoutNode => {
      if (n.type === "pane") {
        const id = uid();
        panes[id] = { id, tabId, title: n.title, target: n.target, status: "connecting", color: st.color };
        return { type: "pane", paneId: id };
      }
      return { type: "split", id: uid(), orientation: n.orientation, children: n.children.map(build) };
    };
    const layout = build(st.layout);
    tabs.push({ id: tabId, kind: "terminal", title: st.title, layout, activePaneId: layoutPaneIds(layout)[0], broadcast: false, color: st.color });
  }
  if (tabs.length) useWorkspace.setState({ tabs, panes, activeTabId: tabs[0].id });
  return tabs.length;
}

import { Fragment, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ChevronDown, ChevronUp, Columns2, Radio, RefreshCw, Rows2, Search, X, Code2, FolderOpen } from "lucide-react";
import { useWorkspace, type LayoutNode, type Pane, type TerminalTab } from "../stores/workspace";
import { useData } from "../stores/data";
import { useSettings } from "../stores/settings";
import { useUi } from "../stores/ui";
import { cn, isMac } from "../lib/utils";
import { StatusDot, StatusPill } from "../components/ui";
import { findSession, getSession } from "./registry";
import { terminalTheme } from "./themes";

function SearchBar({ paneId, onClose }: { paneId: string; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [caseSensitive, setCase] = useState(false);
  const [regex, setRegex] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const s = getSession(paneId);
  useEffect(() => ref.current?.focus(), []);
  const opts = { caseSensitive, regex, decorations: { matchOverviewRuler: "#facc15", activeMatchColorOverviewRuler: "#22d3ee", matchBackground: "#facc1555", activeMatchBackground: "#22d3ee88" } };
  const next = () => q && s.search.findNext(q, opts);
  const prev = () => q && s.search.findPrevious(q, opts);
  const close = () => {
    s.search.clearDecorations();
    onClose();
    s.focus();
  };
  return (
    <div className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-lg border border-line bg-panel-2 px-2 py-1 shadow-lg">
      <Search size={13} className="text-muted" />
      <input
        ref={ref}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          if (e.target.value) s.search.findNext(e.target.value, { ...opts, incremental: true });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.shiftKey ? prev : next)();
          if (e.key === "Escape") close();
        }}
        placeholder="Search"
        className="w-44 bg-transparent px-1 text-[12px] outline-none"
      />
      <button className={cn("rounded px-1 text-[11px]", caseSensitive ? "bg-accent/20 text-accent" : "text-muted")} onClick={() => setCase(!caseSensitive)} title="Match case">
        Aa
      </button>
      <button className={cn("rounded px-1 font-mono text-[11px]", regex ? "bg-accent/20 text-accent" : "text-muted")} onClick={() => setRegex(!regex)} title="Regex">
        .*
      </button>
      <button className="rounded p-0.5 text-muted hover:text-fg" onClick={prev}>
        <ChevronUp size={14} />
      </button>
      <button className="rounded p-0.5 text-muted hover:text-fg" onClick={next}>
        <ChevronDown size={14} />
      </button>
      <button className="rounded p-0.5 text-muted hover:text-fg" onClick={close}>
        <X size={14} />
      </button>
    </div>
  );
}

function PaneView({ paneId, tab, multi }: { paneId: string; tab: TerminalTab; multi: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pane = useWorkspace((s) => s.panes[paneId]);
  const { focusPane, closePane } = useWorkspace();
  const themeId = useSettings((s) => s.settings.terminalTheme);
  const [searching, setSearching] = useState(false);
  const active = tab.activePaneId === paneId;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const session = getSession(paneId);
    session.attach(host);
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => session.fit());
    });
    ro.observe(host);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [paneId]);

  useEffect(() => {
    const onSearch = (e: Event) => {
      if ((e as CustomEvent<string>).detail === paneId) setSearching(true);
    };
    window.addEventListener("termindo:search", onSearch);
    return () => window.removeEventListener("termindo:search", onSearch);
  }, [paneId]);

  if (!pane) return null;
  const bg = terminalTheme(themeId).colors.background;

  const failed = pane.status === "closed" || pane.status === "error";
  const highlight = multi && active;

  return (
    <div
      data-pane-id={paneId}
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden rounded-[10px] border-[1.5px]",
        highlight ? "border-accent" : "border-transparent",
      )}
      style={{ background: bg }}
      onMouseDown={() => focusPane(paneId)}
    >
      <div
        className={cn(
          "group/header flex h-[30px] shrink-0 items-center gap-2 px-3 font-mono text-[13px]",
          highlight ? "bg-accent/10 text-fg" : "bg-panel/70 text-fg-2",
        )}
      >
        <StatusDot status={pane.status} />
        <span className="truncate font-medium">{pane.title}</span>
        {pane.status === "error" && pane.error && <span className="truncate font-sans text-xs text-danger">— {pane.error}</span>}
        <div className="ml-auto flex items-center gap-0.5 text-muted">
          {failed && (
            <button className="rounded p-1 hover:bg-panel-3 hover:text-fg" title="Reconnect" onClick={() => void getSession(paneId).reconnect(true)}>
              <RefreshCw size={14} />
            </button>
          )}
          <button
            className="rounded p-1 opacity-0 transition-opacity hover:bg-panel-3 hover:text-fg group-hover/header:opacity-100"
            title="Search (Ctrl+Shift+F)"
            onClick={() => setSearching(true)}
          >
            <Search size={14} />
          </button>
          <button className="rounded p-1 hover:bg-panel-3 hover:text-fg" title="Close pane (Ctrl+Shift+W)" onClick={() => closePane(paneId)}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0" />
        {searching && <SearchBar paneId={paneId} onClose={() => setSearching(false)} />}
      </div>
    </div>
  );
}

function LayoutView({ node, tab, multi }: { node: LayoutNode; tab: TerminalTab; multi: boolean }) {
  if (node.type === "pane") return <PaneView paneId={node.paneId} tab={tab} multi={multi} />;
  const size = `${(100 / node.children.length).toFixed(2)}%`;
  return (
    <Group orientation={node.orientation} id={node.id} className="h-full w-full">
      {node.children.map((child, i) => (
        <Fragment key={child.type === "pane" ? child.paneId : child.id}>
          {i > 0 && <Separator className={node.orientation === "horizontal" ? "w-2" : "h-2"} />}
          <Panel id={child.type === "pane" ? child.paneId : child.id} defaultSize={size} minSize="8%">
            <LayoutView node={child} tab={tab} multi={multi} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}

function useAddress(pane: Pane | undefined): string {
  const hosts = useData((s) => s.hosts);
  if (!pane) return "";
  const t = pane.target;
  const h = t.hostId ? hosts.find((x) => x.id === t.hostId) : null;
  const user = h?.username ?? t.quick?.username ?? "";
  const host = h?.hostname ?? t.quick?.hostname ?? "";
  const port = h?.port ?? t.quick?.port ?? 22;
  return `${user ? `${user}@` : ""}${host}:${port}`;
}

const STATUS_LABEL: Record<Pane["status"], [string, "ok" | "warn" | "danger" | "muted"]> = {
  connected: ["Connected", "ok"],
  connecting: ["Connecting", "warn"],
  error: ["Error", "danger"],
  closed: ["Disconnected", "muted"],
};

function ToolButton({ icon: Icon, label, onClick, active, title }: { icon: typeof Search; label: string; onClick: () => void; active?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium transition-colors",
        active ? "bg-warn/15 text-warn" : "bg-panel-2 text-fg-2 hover:bg-panel-3 hover:text-fg",
      )}
    >
      <Icon size={16} />
      {label}
    </button>
  );
}

function Toolbar({ tab }: { tab: TerminalTab }) {
  const pane = useWorkspace((s) => s.panes[tab.activePaneId]);
  const { splitPane, toggleBroadcast, openSftp } = useWorkspace();
  const setSnippetPaletteOpen = useUi((s) => s.setSnippetPaletteOpen);
  const address = useAddress(pane);
  if (!pane) return null;
  const [label, tone] = STATUS_LABEL[pane.status];
  return (
    <div className="mx-2 flex h-11 shrink-0 items-center gap-3 rounded-[10px] bg-panel px-3">
      <StatusPill tone={tone}>{label}</StatusPill>
      <span className="truncate font-mono text-[13px] text-fg-2">{address}</span>
      <div className="flex-1" />
      <ToolButton icon={Columns2} label="Split right" title="Split right (Ctrl+Shift+D)" onClick={() => splitPane(pane.id, "horizontal")} />
      <ToolButton icon={Rows2} label="Split down" title="Split down (Ctrl+Shift+E)" onClick={() => splitPane(pane.id, "vertical")} />
      <ToolButton icon={Radio} label="Broadcast" title="Send keystrokes to every pane in this tab" active={tab.broadcast} onClick={() => toggleBroadcast(tab.id)} />
      <ToolButton icon={Code2} label="Snippets" title="Run snippet (Ctrl+Shift+S)" onClick={() => setSnippetPaletteOpen(true)} />
      <ToolButton icon={FolderOpen} label="SFTP" title="Open SFTP" onClick={() => openSftp(pane.target, pane.title, pane.color)} />
    </div>
  );
}

function StatusBar({ tab }: { tab: TerminalTab }) {
  const paneId = tab.activePaneId;
  const hosts = useData((s) => s.hosts);
  const pane = useWorkspace((s) => s.panes[paneId]);
  const [size, setSize] = useState<[number, number] | null>(null);
  useEffect(() => {
    // Only read an existing session; the pane view owns its creation.
    const term = findSession(paneId)?.term;
    if (!term) return setSize(null);
    setSize([term.cols, term.rows]);
    const d = term.onResize(({ cols, rows }) => setSize([cols, rows]));
    return () => d.dispose();
  }, [paneId]);
  const host = pane?.target.hostId ? hosts.find((h) => h.id === pane.target.hostId) : null;
  const termType = host?.options.termType || "xterm-256color";
  return (
    <div className="flex h-8 shrink-0 items-center gap-4 px-3.5 font-mono text-[11px] text-muted">
      <span>SSH</span>
      <span>UTF-8</span>
      <span>{termType}</span>
      {size && (
        <span>
          {size[0]}×{size[1]}
        </span>
      )}
      <span className="ml-auto font-sans">
        {isMac ? "⌥" : "Alt"}+←/→ switch pane · {isMac ? "⌘⇧D" : "Ctrl+Shift+D"} split
      </span>
    </div>
  );
}

export function TerminalTabView({ tab }: { tab: TerminalTab }) {
  const multi = tab.layout.type === "split";
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 bg-bg">
      <Toolbar tab={tab} />
      {tab.broadcast && (
        <div className="mx-2 flex h-7 shrink-0 items-center justify-center gap-2 rounded-lg bg-warn/12 text-xs text-warn">
          <Radio size={13} /> Broadcasting keystrokes to every pane in this tab
        </div>
      )}
      <div className="min-h-0 flex-1 px-2">
        <LayoutView node={tab.layout} tab={tab} multi={multi} />
      </div>
      <StatusBar tab={tab} />
    </div>
  );
}

import { Fragment, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ChevronDown, ChevronUp, Columns2, Radio, RefreshCw, Rows2, Search, X, Code2, FolderOpen } from "lucide-react";
import { useWorkspace, type LayoutNode, type TerminalTab } from "../stores/workspace";
import { useSettings } from "../stores/settings";
import { useUi } from "../stores/ui";
import { cn } from "../lib/utils";
import { StatusDot } from "../components/ui";
import { getSession } from "./registry";
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
    <div className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-md border border-line bg-panel px-1.5 py-1 shadow-lg">
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
  const { focusPane, splitPane, closePane, toggleBroadcast, openSftp } = useWorkspace();
  const setSnippetPaletteOpen = useUi((s) => s.setSnippetPaletteOpen);
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

  return (
    <div
      data-pane-id={paneId}
      className={cn("relative flex h-full w-full flex-col", multi && active && "ring-1 ring-inset ring-accent/50")}
      style={{ background: bg }}
      onMouseDown={() => focusPane(paneId)}
    >
      <div className="group/header flex h-7 shrink-0 items-center gap-2 border-b border-line/60 bg-panel/80 px-2 text-[11.5px] text-muted">
        <StatusDot status={pane.status} />
        <span className="truncate">{pane.title}</span>
        {pane.status === "error" && pane.error && <span className="truncate text-danger">— {pane.error}</span>}
        <div className="ml-auto flex items-center gap-0.5">
          {(pane.status === "closed" || pane.status === "error") && (
            <button className="rounded p-1 hover:bg-hover hover:text-fg" title="Reconnect" onClick={() => void getSession(paneId).reconnect(true)}>
              <RefreshCw size={13} />
            </button>
          )}
          <button className="rounded p-1 hover:bg-hover hover:text-fg" title="Snippets (Ctrl+Shift+S)" onClick={() => setSnippetPaletteOpen(true)}>
            <Code2 size={13} />
          </button>
          <button
            className="rounded p-1 hover:bg-hover hover:text-fg"
            title="Open SFTP"
            onClick={() => openSftp(pane.target, pane.title, pane.color)}
          >
            <FolderOpen size={13} />
          </button>
          <button className="rounded p-1 hover:bg-hover hover:text-fg" title="Search (Ctrl+Shift+F)" onClick={() => setSearching(true)}>
            <Search size={13} />
          </button>
          <button
            className={cn("rounded p-1 hover:bg-hover hover:text-fg", tab.broadcast && "text-warn")}
            title="Broadcast input to all panes in this tab"
            onClick={() => toggleBroadcast(tab.id)}
          >
            <Radio size={13} />
          </button>
          <button className="rounded p-1 hover:bg-hover hover:text-fg" title="Split right (Ctrl+Shift+D)" onClick={() => splitPane(paneId, "horizontal")}>
            <Columns2 size={13} />
          </button>
          <button className="rounded p-1 hover:bg-hover hover:text-fg" title="Split down (Ctrl+Shift+E)" onClick={() => splitPane(paneId, "vertical")}>
            <Rows2 size={13} />
          </button>
          <button className="rounded p-1 hover:bg-hover hover:text-danger" title="Close pane (Ctrl+Shift+W)" onClick={() => closePane(paneId)}>
            <X size={13} />
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
          {i > 0 && <Separator className={node.orientation === "horizontal" ? "w-[3px]" : "h-[3px]"} />}
          <Panel id={child.type === "pane" ? child.paneId : child.id} defaultSize={size} minSize="8%">
            <LayoutView node={child} tab={tab} multi={multi} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}

export function TerminalTabView({ tab }: { tab: TerminalTab }) {
  const multi = tab.layout.type === "split";
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {tab.broadcast && (
        <div className="flex h-6 shrink-0 items-center justify-center gap-2 bg-warn/15 text-[11px] text-warn">
          <Radio size={12} /> Broadcasting keystrokes to every pane in this tab
        </div>
      )}
      <div className="min-h-0 flex-1">
        <LayoutView node={tab.layout} tab={tab} multi={multi} />
      </div>
    </div>
  );
}

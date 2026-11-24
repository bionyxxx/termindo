import { useEffect, useMemo, useRef, useState } from "react";
import * as RDialog from "@radix-ui/react-dialog";
import { FolderOpen, Lock, Server, Settings, Terminal, Zap, Code2, ArrowRightLeft } from "lucide-react";
import { connectHost, parseQuick, quickConnect, sftpHost } from "../lib/actions";
import { cn } from "../lib/utils";
import { hostTitle, useData } from "../stores/data";
import { useApp } from "../stores/app";
import { useUi } from "../stores/ui";
import { HOME_TAB, useWorkspace } from "../stores/workspace";

interface Item {
  id: string;
  icon: typeof Server;
  title: string;
  subtitle?: string;
  run: (alt: boolean) => void;
}

function score(text: string, q: string): number {
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 3;
  if (t.includes(q)) return 2;
  // subsequence match
  let i = 0;
  for (const c of t) if (c === q[i]) i++;
  return i === q.length ? 1 : 0;
}

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, setView, setSnippetPaletteOpen } = useUi();
  const hosts = useData((s) => s.hosts);
  const { tabs, setActiveTab } = useWorkspace();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paletteOpen) {
      setQ("");
      setSel(0);
    }
  }, [paletteOpen]);

  const items = useMemo<Item[]>(() => {
    const query = q.trim().toLowerCase();
    const out: { item: Item; s: number }[] = [];
    for (const h of hosts) {
      const s = Math.max(score(hostTitle(h), query), score(h.hostname, query), ...h.tags.map((t) => score(t, query)));
      if (s > 0)
        out.push({
          s: s + 0.5,
          item: {
            id: `h:${h.id}`,
            icon: Server,
            title: hostTitle(h),
            subtitle: `${h.username ? h.username + "@" : ""}${h.hostname}${h.port !== 22 ? ":" + h.port : ""}`,
            run: (alt) => (alt ? sftpHost(h) : connectHost(h)),
          },
        });
    }
    for (const t of tabs) {
      const s = score(t.title, query);
      if (s > 0 && query)
        out.push({ s, item: { id: `t:${t.id}`, icon: ArrowRightLeft, title: `Switch to ${t.title}`, subtitle: t.kind, run: () => setActiveTab(t.id) } });
    }
    const actions: Item[] = [
      { id: "a:snip", icon: Code2, title: "Run snippet…", run: () => setTimeout(() => setSnippetPaletteOpen(true), 50) },
      { id: "a:new", icon: Server, title: "New host", run: () => (setActiveTab(HOME_TAB), setView("hosts")) },
      { id: "a:settings", icon: Settings, title: "Settings", run: () => (setActiveTab(HOME_TAB), setView("settings")) },
      { id: "a:lock", icon: Lock, title: "Lock vault", run: () => void useApp.getState().lock() },
    ];
    for (const a of actions) {
      const s = score(a.title, query);
      if (s > 0) out.push({ s: s - 0.5, item: a });
    }
    out.sort((a, b) => b.s - a.s);
    const list = out.map((o) => o.item);
    const quick = parseQuick(q);
    if (quick && q.trim() && (q.includes("@") || q.includes(".") || q.includes(":"))) {
      list.unshift({
        id: "quick",
        icon: Zap,
        title: `Connect to ${q.trim()}`,
        subtitle: "Quick connect (not saved)",
        run: () => void quickConnect(q),
      });
    }
    return list.slice(0, 50);
  }, [q, hosts, tabs, setActiveTab, setView, setSnippetPaletteOpen]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (i: number, alt: boolean) => {
    const item = items[i];
    if (!item) return;
    setPaletteOpen(false);
    item.run(alt);
  };

  return (
    <RDialog.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RDialog.Content className="fixed left-1/2 top-[14vh] z-50 w-[620px] max-w-[92vw] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-panel shadow-2xl outline-none">
          <RDialog.Title className="sr-only">Command palette</RDialog.Title>
          <RDialog.Description className="sr-only">Search hosts and actions</RDialog.Description>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(items.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(sel, e.shiftKey);
              }
            }}
            placeholder="Search hosts, or type user@host:port to connect…"
            spellCheck={false}
            className="w-full border-b border-line bg-transparent px-4 py-3.5 text-[14px] outline-none placeholder:text-muted"
          />
          <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
            {items.length === 0 && <div className="px-3 py-6 text-center text-xs text-muted">No results</div>}
            {items.map((it, i) => (
              <button
                key={it.id}
                data-idx={i}
                onMouseMove={() => setSel(i)}
                onClick={(e) => run(i, e.shiftKey)}
                className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left", i === sel ? "bg-accent/15" : "")}
              >
                <it.icon size={16} className={i === sel ? "text-accent" : "text-muted"} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{it.title}</div>
                  {it.subtitle && <div className="truncate font-mono text-[11px] text-muted">{it.subtitle}</div>}
                </div>
                {it.id.startsWith("h:") && i === sel && (
                  <span className="flex items-center gap-2 text-[10.5px] text-muted">
                    <Terminal size={12} /> Enter
                    <FolderOpen size={12} /> Shift+Enter
                  </span>
                )}
              </button>
            ))}
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

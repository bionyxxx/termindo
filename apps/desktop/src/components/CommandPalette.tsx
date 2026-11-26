import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import * as RDialog from "@radix-ui/react-dialog";
import { ArrowRightLeft, ArrowUpDown, Code2, CornerDownLeft, Lock, Plus, Search, Server, Settings, Zap } from "lucide-react";
import { connectHost, parseQuick, quickConnect, sftpHost } from "../lib/actions";
import { cn, isMac } from "../lib/utils";
import { hostColor, hostTitle, useData } from "../stores/data";
import { Caption, Kbd } from "./ui";
import { useApp } from "../stores/app";
import { useUi } from "../stores/ui";
import { HOME_TAB, useWorkspace } from "../stores/workspace";

interface Item {
  id: string;
  section: "Hosts" | "Tabs" | "Actions";
  icon: typeof Server;
  /** Avatar color for hosts. */
  color?: string;
  title: string;
  subtitle?: string;
  kbd?: string;
  run: (alt: boolean) => void;
}

const SECTIONS: Item["section"][] = ["Hosts", "Tabs", "Actions"];

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
  const groups = useData((s) => s.groups);
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
            section: "Hosts",
            icon: Server,
            color: hostColor(groups, h),
            title: hostTitle(h),
            subtitle: [
              `${h.username ? h.username + "@" : ""}${h.hostname}${h.port !== 22 ? ":" + h.port : ""}`,
              groups.find((g) => g.id === h.groupId)?.name,
            ]
              .filter(Boolean)
              .join(" · "),
            run: (alt) => (alt ? sftpHost(h) : connectHost(h)),
          },
        });
    }
    for (const t of tabs) {
      const s = score(t.title, query);
      if (s > 0 && query)
        out.push({ s, item: { id: `t:${t.id}`, section: "Tabs", icon: ArrowRightLeft, title: `Switch to ${t.title}`, subtitle: t.kind, run: () => setActiveTab(t.id) } });
    }
    const mod = isMac ? "⌘" : "Ctrl";
    const actions: Item[] = [
      { id: "a:snip", section: "Actions", icon: Code2, title: "Run snippet…", kbd: `${mod} ⇧ S`, run: () => setTimeout(() => setSnippetPaletteOpen(true), 50) },
      { id: "a:new", section: "Actions", icon: Plus, title: "New host", run: () => (setActiveTab(HOME_TAB), setView("hosts")) },
      { id: "a:settings", section: "Actions", icon: Settings, title: "Settings", run: () => (setActiveTab(HOME_TAB), setView("settings")) },
      { id: "a:lock", section: "Actions", icon: Lock, title: "Lock vault", kbd: `${mod} ⇧ L`, run: () => void useApp.getState().lock() },
    ];
    for (const a of actions) {
      const s = score(a.title, query);
      if (s > 0) out.push({ s: s - 0.5, item: a });
    }
    const quick = parseQuick(q);
    if (quick && q.trim()) {
      // An address-like query ranks above everything else.
      const addressy = q.includes("@") || q.includes(".") || q.includes(":");
      out.push({
        s: addressy ? 100 : 0,
        item: {
          id: "quick",
          section: addressy ? "Hosts" : "Actions",
          icon: Zap,
          title: `Quick connect to “${q.trim()}”`,
          subtitle: `ssh ${quick.username ? quick.username + "@" : ""}${quick.hostname}:${quick.port ?? 22}`,
          run: () => void quickConnect(q),
        },
      });
    }
    out.sort((a, b) => b.s - a.s);
    // Group by section (stable within a section), so keyboard order matches what is shown.
    const list = SECTIONS.flatMap((sec) => out.filter((o) => o.item.section === sec).map((o) => o.item));
    return list.slice(0, 50);
  }, [q, hosts, groups, tabs, setActiveTab, setView, setSnippetPaletteOpen]);

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

  const mod = isMac ? "⌘" : "Ctrl";
  return (
    <RDialog.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <RDialog.Content className="fixed left-1/2 top-[110px] z-50 flex max-h-[calc(100vh-160px)] w-[640px] max-w-[92vw] -translate-x-1/2 flex-col overflow-hidden rounded-[14px] border border-line bg-panel-2 shadow-2xl outline-none">
          <RDialog.Title className="sr-only">Command palette</RDialog.Title>
          <RDialog.Description className="sr-only">Search hosts and actions</RDialog.Description>
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
            <Search size={18} className="shrink-0 text-accent" />
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
                  run(sel, e.shiftKey || e.ctrlKey || e.metaKey);
                }
              }}
              placeholder="Search hosts, or type user@host:port to connect…"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[17px] text-fg caret-accent outline-none placeholder:text-muted"
            />
            <Kbd>Esc</Kbd>
          </div>
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
            {items.length === 0 && <div className="px-3 py-8 text-center text-[13px] text-muted">No results</div>}
            {items.map((it, i) => (
              <Fragment key={it.id}>
                {(i === 0 || items[i - 1].section !== it.section) && <Caption className="px-3 pb-1.5 pt-2.5">{it.section}</Caption>}
                <button
                  data-idx={i}
                  onMouseMove={() => setSel(i)}
                  onClick={(e) => run(i, e.shiftKey || e.ctrlKey || e.metaKey)}
                  className={cn("flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left", i === sel && "bg-panel-3")}
                >
                  {it.color ? (
                    <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-[#0b0f17]" style={{ background: it.color }}>
                      <it.icon size={16} />
                    </span>
                  ) : (
                    <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-panel-3 text-fg-2">
                      <it.icon size={16} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-fg">{it.title}</div>
                    {it.subtitle && <div className="truncate font-mono text-xs text-muted">{it.subtitle}</div>}
                  </div>
                  {it.id.startsWith("h:") && i === sel ? (
                    <span className="flex shrink-0 gap-1.5">
                      <Kbd className="bg-panel-2">↵ SSH</Kbd>
                      <Kbd className="bg-panel-2">{mod} ↵ SFTP</Kbd>
                    </span>
                  ) : (
                    it.kbd && <Kbd className="shrink-0">{it.kbd}</Kbd>
                  )}
                </button>
              </Fragment>
            ))}
          </div>
          <div className="flex h-10 shrink-0 items-center gap-5 border-t border-line bg-panel px-4 text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <ArrowUpDown size={13} /> Navigate
            </span>
            <span className="flex items-center gap-1.5">
              <CornerDownLeft size={13} /> Open
            </span>
            <span className="flex items-center gap-1.5">
              <span className="font-mono text-fg-2">{mod} ↵</span> SFTP
            </span>
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

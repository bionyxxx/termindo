import { useMemo, useState } from "react";
import * as DM from "@radix-ui/react-dropdown-menu";
import * as CM from "@radix-ui/react-context-menu";
import { Plus, Search, Server, Terminal, FolderOpen, Pencil, Copy, Trash2, FileInput, LayoutGrid, List, MoreHorizontal, Clock, Eye, EyeOff } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { connectHost, sftpHost } from "../lib/actions";
import { startDrag } from "../lib/drag";
import { cn, timeAgo } from "../lib/utils";
import { emptyHost, groupDescendants, groupHostCount, hostColor, hostTitle, useData } from "../stores/data";
import { confirmDialog, toast, useUi } from "../stores/ui";
import type { Host } from "../lib/types";
import { Badge, Button, Empty, Input, PageHeader } from "../components/ui";
import { HostEditor } from "./HostEditor";

type Layout = "grid" | "list";
const LAYOUT_KEY = "termindo.hostsLayout";
const HIDE_KEY = "termindo.hostsHideCredentials";
const MASK = "••••••••";

function readLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
}

const MENU_ITEM =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-panel-3 data-[highlighted]:text-fg";
const MENU = "z-50 min-w-[180px] rounded-lg border border-line bg-panel-2 p-1 text-fg-2 shadow-xl";

function useHostActions(host: Host, onEdit: () => void) {
  const loadHosts = useData((s) => s.loadHosts);
  const del = async () => {
    if (!(await confirmDialog({ title: "Delete host?", message: `${hostTitle(host)} will be removed from all synced devices.`, danger: true, confirmLabel: "Delete" })))
      return;
    try {
      await api.hostDelete(host.id);
      await loadHosts();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const duplicate = () =>
    void api
      .hostDuplicate(host.id)
      .then(() => loadHosts())
      .catch((e) => toast(errorMessage(e), "error"));
  return [
    { icon: Terminal, label: "Connect", run: () => connectHost(host) },
    { icon: FolderOpen, label: "Open SFTP", run: () => sftpHost(host) },
    null,
    { icon: Pencil, label: "Edit", run: onEdit },
    { icon: Copy, label: "Duplicate", run: duplicate },
    { icon: Trash2, label: "Delete", run: () => void del(), danger: true },
  ] as const;
}

/** The same actions as a right-click menu and as the "…" dropdown. */
function HostMenu({ host, onEdit, children }: { host: Host; onEdit: () => void; children: React.ReactNode }) {
  const items = useHostActions(host, onEdit);
  return (
    <CM.Root>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal>
        <CM.Content className={MENU}>
          {items.map((it, i) =>
            it ? (
              <CM.Item key={it.label} onSelect={it.run} className={cn(MENU_ITEM, "danger" in it && "text-danger data-[highlighted]:text-danger")}>
                <it.icon size={14} /> {it.label}
              </CM.Item>
            ) : (
              <CM.Separator key={i} className="my-1 h-px bg-line" />
            ),
          )}
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}

function MoreButton({ host, onEdit }: { host: Host; onEdit: () => void }) {
  const items = useHostActions(host, onEdit);
  return (
    <DM.Root>
      <DM.Trigger asChild>
        <button className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-panel-2 hover:text-fg" title="More">
          <MoreHorizontal size={18} />
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="end" sideOffset={4} className={MENU}>
          {items.map((it, i) =>
            it ? (
              <DM.Item key={it.label} onSelect={it.run} className={cn(MENU_ITEM, "danger" in it && "text-danger data-[highlighted]:text-danger")}>
                <it.icon size={14} /> {it.label}
              </DM.Item>
            ) : (
              <DM.Separator key={i} className="my-1 h-px bg-line" />
            ),
          )}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

function HostAvatar({ host, size = 40 }: { host: Host; size?: number }) {
  const groups = useData((s) => s.groups);
  return (
    <div
      className="flex shrink-0 items-center justify-center text-[#0b0f17]"
      style={{ background: hostColor(groups, host), width: size, height: size, borderRadius: size / 4 }}
    >
      <Server size={size / 2} />
    </div>
  );
}

/** `hidden` masks user, hostname and port (e.g. while screen sharing). */
function address(h: Host, hidden: boolean) {
  if (hidden) return `${h.username ? "•••@" : ""}${MASK}`;
  return `${h.username ? `${h.username}@` : ""}${h.hostname}${h.port !== 22 ? `:${h.port}` : ""}`;
}

/** Hosts without a label fall back to their hostname, so mask that too. */
function title(h: Host, hidden: boolean) {
  return hidden && !h.label ? MASK : hostTitle(h);
}

function AuthTag({ host, hidden }: { host: Host; hidden: boolean }) {
  const credentials = useData((s) => s.credentials);
  const cred = credentials.find((c) => c.id === host.credentialId);
  const label =
    host.authType === "key" ? (cred && !hidden ? `key · ${cred.label}` : "key") : host.authType === "interactive" ? "interactive" : host.authType;
  return <Badge>{label}</Badge>;
}

function HostCard({ host, hidden, onEdit }: { host: Host; hidden: boolean; onEdit: () => void }) {
  const st = useData((s) => s.stats[host.id]);
  return (
    <HostMenu host={host} onEdit={onEdit}>
      <div
        onPointerDown={(e) => startDrag(e, "termindo/host", () => ({ data: host.id, label: title(host, hidden) }))}
        onDoubleClick={() => connectHost(host)}
        className="flex cursor-default flex-col gap-3.5 rounded-xl bg-panel p-4 outline outline-1 -outline-offset-1 outline-transparent transition-colors hover:outline-line"
      >
        <div className="flex items-center gap-3">
          <HostAvatar host={host} />
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <div className="truncate text-[15px] font-semibold text-fg">{title(host, hidden)}</div>
            <div className="truncate font-mono text-xs text-muted">{address(host, hidden)}</div>
          </div>
          <MoreButton host={host} onEdit={onEdit} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <AuthTag host={host} hidden={hidden} />
          {host.jumpHostId && <Badge>via jump</Badge>}
          {host.tags.map((t) => (
            <Badge key={t}>#{t}</Badge>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Clock size={13} className="shrink-0 text-muted" />
          <span className="flex-1 truncate text-xs text-muted">{st?.lastConnectedAt ? timeAgo(st.lastConnectedAt) : "never"}</span>
          <Button size="icon" variant="ghost" title="Open SFTP" onClick={() => sftpHost(host)}>
            <FolderOpen size={16} />
          </Button>
          <Button size="sm" variant="primary" onClick={() => connectHost(host)}>
            <Terminal size={16} /> Connect
          </Button>
        </div>
      </div>
    </HostMenu>
  );
}

function HostRow({ host, hidden, onEdit }: { host: Host; hidden: boolean; onEdit: () => void }) {
  const st = useData((s) => s.stats[host.id]);
  return (
    <HostMenu host={host} onEdit={onEdit}>
      <div
        onPointerDown={(e) => startDrag(e, "termindo/host", () => ({ data: host.id, label: title(host, hidden) }))}
        onDoubleClick={() => connectHost(host)}
        className="flex cursor-default items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-panel-2/50"
      >
        <HostAvatar host={host} size={28} />
        <div className="flex w-56 min-w-0 flex-col">
          <span className="truncate text-sm font-semibold text-fg">{title(host, hidden)}</span>
          <span className="truncate font-mono text-xs text-muted">{address(host, hidden)}</span>
        </div>
        <div className="flex min-w-0 flex-1 gap-1.5 overflow-hidden">
          <AuthTag host={host} hidden={hidden} />
          {host.tags.map((t) => (
            <Badge key={t}>#{t}</Badge>
          ))}
        </div>
        <span className="w-20 shrink-0 text-xs text-muted">{st?.lastConnectedAt ? timeAgo(st.lastConnectedAt) : "never"}</span>
        <Button size="icon" variant="ghost" title="Open SFTP" onClick={() => sftpHost(host)}>
          <FolderOpen size={16} />
        </Button>
        <Button size="sm" variant="primary" onClick={() => connectHost(host)}>
          <Terminal size={16} /> Connect
        </Button>
        <MoreButton host={host} onEdit={onEdit} />
      </div>
    </HostMenu>
  );
}

export function HostsView() {
  const { hosts, groups, loadAll } = useData();
  const { hostGroup: selected, setHostGroup: setSelected } = useUi();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Host | null>(null);
  const [layout, setLayoutState] = useState<Layout>(readLayout);
  const [hidden, setHiddenState] = useState(readHidden);
  const toggleHidden = () => {
    const next = !hidden;
    setHiddenState(next);
    try {
      localStorage.setItem(HIDE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  const setLayout = (l: Layout) => {
    setLayoutState(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* ignore */
    }
  };

  const tops = groups.filter((g) => !g.parentId);
  // A nested group picked in the sidebar is shown as an extra segment so the filter stays visible.
  const segments = selected && !tops.some((g) => g.id === selected) ? [...tops, ...groups.filter((g) => g.id === selected)] : tops;

  const filtered = useMemo(() => {
    const ids = selected ? groupDescendants(groups, selected) : null;
    const q = query.trim().toLowerCase();
    return hosts.filter((h) => {
      if (ids && !(h.groupId && ids.has(h.groupId))) return false;
      if (!q) return true;
      return [h.label, h.hostname, h.username, ...h.tags, h.notes].some((v) => v.toLowerCase().includes(q));
    });
  }, [hosts, groups, selected, query]);

  const importSsh = async () => {
    try {
      const r = await api.importSshConfig();
      await loadAll();
      toast(`Imported ${r.hosts} host(s) and ${r.keys} key(s) from ~/.ssh/config${r.skipped ? `, ${r.skipped} already existed` : ""}.`, "success");
      for (const w of r.warnings.slice(0, 3)) toast(w, "error");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const groupCount = new Set(hosts.map((h) => h.groupId).filter(Boolean)).size;

  return (
    <div className="px-8 pb-8 pt-4">
      <PageHeader
        title="Hosts"
        subtitle={`${hosts.length} host${hosts.length === 1 ? "" : "s"} across ${groupCount} group${groupCount === 1 ? "" : "s"}`}
        actions={
          <>
            <Button onClick={() => void importSsh()} title="Import from ~/.ssh/config">
              <FileInput size={16} /> Import SSH config
            </Button>
            <Button variant="primary" onClick={() => setEditing(emptyHost(selected))}>
              <Plus size={16} /> New host
            </Button>
          </>
        }
      />

      <div className="mb-6 flex items-center gap-3">
        <div className="relative w-[300px] shrink-0">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search hosts, tags…" className="pl-[38px]" />
        </div>
        {tops.length > 0 && (
          <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-[10px] bg-panel p-1 [scrollbar-width:none]">
            {[{ id: null as string | null, name: "All", count: hosts.length }, ...segments.map((g) => ({ id: g.id as string | null, name: g.name, count: groupHostCount(groups, hosts, g.id) }))].map(
              (s) => (
                <button
                  key={s.id ?? "all"}
                  onClick={() => setSelected(s.id)}
                  className={cn(
                    "flex h-8 shrink-0 items-center gap-2 rounded-[7px] px-3 text-[13px] transition-colors",
                    selected === s.id ? "bg-panel-3 font-semibold text-fg" : "font-medium text-fg-2 hover:text-fg",
                  )}
                >
                  {s.name}
                  <span className="font-mono text-[11px] font-normal text-muted">{s.count}</span>
                </button>
              ),
            )}
          </div>
        )}
        <div className="flex-1" />
        <div className="flex shrink-0 rounded-[10px] bg-panel p-1">
          <button
            title={hidden ? "Show credentials" : "Hide credentials"}
            aria-pressed={hidden}
            onClick={toggleHidden}
            className={cn("flex h-8 w-8 items-center justify-center rounded-[7px]", hidden ? "bg-panel-3 text-fg" : "text-muted hover:text-fg")}
          >
            {hidden ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <div className="flex shrink-0 gap-0.5 rounded-[10px] bg-panel p-1">
          {(
            [
              ["grid", LayoutGrid],
              ["list", List],
            ] as const
          ).map(([id, Icon]) => (
            <button
              key={id}
              title={id === "grid" ? "Cards" : "List"}
              onClick={() => setLayout(id)}
              className={cn("flex h-8 w-8 items-center justify-center rounded-[7px]", layout === id ? "bg-panel-3 text-fg" : "text-muted hover:text-fg")}
            >
              <Icon size={16} />
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <Empty icon={<Server size={22} />} title={hosts.length === 0 ? "No hosts yet" : "No matching hosts"}>
          {hosts.length === 0 ? "Add a host, import your ~/.ssh/config, or press Ctrl K to quick connect." : "Try a different search or group."}
        </Empty>
      ) : layout === "grid" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-4">
          {filtered.map((h) => (
            <HostCard key={h.id} host={h} hidden={hidden} onEdit={() => setEditing(h)} />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-panel">
          {filtered.map((h) => (
            <HostRow key={h.id} host={h} hidden={hidden} onEdit={() => setEditing(h)} />
          ))}
        </div>
      )}

      <HostEditor host={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

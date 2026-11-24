import { useMemo, useState } from "react";
import * as CM from "@radix-ui/react-context-menu";
import {
  ChevronRight,
  Folder,
  FolderPlus,
  Plus,
  Search,
  Server,
  Terminal,
  FolderOpen,
  Pencil,
  Copy,
  Trash2,
  Zap,
  FileInput,
  Layers,
} from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { connectHost, quickConnect, sftpHost } from "../lib/actions";
import { cn, timeAgo } from "../lib/utils";
import { emptyHost, hostTitle, useData } from "../stores/data";
import { confirmDialog, toast } from "../stores/ui";
import type { Group, Host } from "../lib/types";
import { Badge, Button, Empty, Input } from "../components/ui";
import { GroupEditor, HostEditor } from "./HostEditor";

const ALL = "__all__";

function descendants(groups: Group[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of groups) {
      if (g.parentId && out.has(g.parentId) && !out.has(g.id)) {
        out.add(g.id);
        changed = true;
      }
    }
  }
  return out;
}

function GroupTree({
  groups,
  hosts,
  selected,
  onSelect,
  onEdit,
  onDelete,
}: {
  groups: Group[];
  hosts: Host[];
  selected: string;
  onSelect: (id: string) => void;
  onEdit: (g: Group) => void;
  onDelete: (g: Group) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const count = (id: string) => {
    const ids = descendants(groups, id);
    return hosts.filter((h) => h.groupId && ids.has(h.groupId)).length;
  };
  const render = (parentId: string | null, depth: number): React.ReactNode =>
    groups
      .filter((g) => (g.parentId ?? null) === parentId)
      .map((g) => {
        const hasChildren = groups.some((c) => c.parentId === g.id);
        return (
          <div key={g.id}>
            <CM.Root>
              <CM.Trigger asChild>
                <button
                  onClick={() => onSelect(g.id)}
                  onDragOver={(e) => e.dataTransfer.types.includes("termindo/host") && e.preventDefault()}
                  onDrop={(e) => {
                    const hostId = e.dataTransfer.getData("termindo/host");
                    const host = hosts.find((h) => h.id === hostId);
                    if (host) void api.hostSave({ ...host, groupId: g.id }).then(() => useData.getState().loadHosts());
                  }}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[12.5px]",
                    selected === g.id ? "bg-accent/15 text-accent" : "text-fg/90 hover:bg-hover",
                  )}
                  style={{ paddingLeft: 8 + depth * 14 }}
                >
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }));
                    }}
                    className={cn("text-muted transition-transform", !hasChildren && "invisible", !collapsed[g.id] && "rotate-90")}
                  >
                    <ChevronRight size={12} />
                  </span>
                  <Folder size={14} style={{ color: g.color ?? undefined }} className={g.color ? "" : "text-muted"} />
                  <span className="truncate">{g.name}</span>
                  <span className="ml-auto text-[11px] text-muted">{count(g.id)}</span>
                </button>
              </CM.Trigger>
              <CM.Portal>
                <CM.Content className="z-50 min-w-[160px] rounded-lg border border-line bg-panel p-1 shadow-xl">
                  <MenuItem icon={Pencil} onSelect={() => onEdit(g)}>
                    Edit group
                  </MenuItem>
                  <MenuItem icon={Trash2} danger onSelect={() => onDelete(g)}>
                    Delete group
                  </MenuItem>
                </CM.Content>
              </CM.Portal>
            </CM.Root>
            {!collapsed[g.id] && render(g.id, depth + 1)}
          </div>
        );
      });
  return (
    <div className="flex flex-col gap-0.5">
      <button
        onClick={() => onSelect(ALL)}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px]",
          selected === ALL ? "bg-accent/15 text-accent" : "hover:bg-hover",
        )}
      >
        <Layers size={14} /> All hosts <span className="ml-auto text-[11px] text-muted">{hosts.length}</span>
      </button>
      {render(null, 0)}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  children,
  onSelect,
  danger,
}: {
  icon: typeof Server;
  children: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
}) {
  return (
    <CM.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] outline-none data-[highlighted]:bg-hover",
        danger && "text-danger",
      )}
    >
      <Icon size={14} /> {children}
    </CM.Item>
  );
}

function HostCard({ host, onEdit }: { host: Host; onEdit: () => void }) {
  const { groups, stats, credentials, loadHosts } = useData();
  const group = groups.find((g) => g.id === host.groupId);
  const st = stats[host.id];
  const cred = credentials.find((c) => c.id === host.credentialId);
  const color = host.options.color || group?.color || undefined;
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
  return (
    <CM.Root>
      <CM.Trigger asChild>
        <div
          draggable
          onDragStart={(e) => e.dataTransfer.setData("termindo/host", host.id)}
          onDoubleClick={() => connectHost(host)}
          className="group relative flex cursor-default flex-col gap-2 rounded-xl border border-line bg-panel p-3.5 transition-colors hover:border-accent/50"
        >
          <div className="flex items-start gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white"
              style={{ background: color ?? "var(--app-panel-2)" }}
            >
              <Server size={17} className={color ? "" : "text-muted"} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{hostTitle(host)}</div>
              <div className="truncate font-mono text-[11.5px] text-muted">
                {host.username ? `${host.username}@` : ""}
                {host.hostname}
                {host.port !== 22 ? `:${host.port}` : ""}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Badge>{host.authType === "key" ? (cred ? `key: ${cred.label}` : "key") : host.authType}</Badge>
            {host.jumpHostId && <Badge>via jump</Badge>}
            {host.tags.map((t) => (
              <Badge key={t} className="text-accent/90">
                #{t}
              </Badge>
            ))}
          </div>
          <div className="text-[11px] text-muted">{st?.lastConnectedAt ? `Last connected ${timeAgo(st.lastConnectedAt)}` : "Never connected"}</div>
          <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <Button size="icon" variant="ghost" title="SFTP" onClick={() => sftpHost(host)}>
              <FolderOpen size={14} />
            </Button>
            <Button size="icon" variant="ghost" title="Edit" onClick={onEdit}>
              <Pencil size={14} />
            </Button>
            <Button size="icon" variant="primary" title="Connect" onClick={() => connectHost(host)}>
              <Terminal size={14} />
            </Button>
          </div>
        </div>
      </CM.Trigger>
      <CM.Portal>
        <CM.Content className="z-50 min-w-[180px] rounded-lg border border-line bg-panel p-1 shadow-xl">
          <MenuItem icon={Terminal} onSelect={() => connectHost(host)}>
            Connect
          </MenuItem>
          <MenuItem icon={FolderOpen} onSelect={() => sftpHost(host)}>
            Open SFTP
          </MenuItem>
          <CM.Separator className="my-1 h-px bg-line" />
          <MenuItem icon={Pencil} onSelect={onEdit}>
            Edit
          </MenuItem>
          <MenuItem
            icon={Copy}
            onSelect={() =>
              void api
                .hostDuplicate(host.id)
                .then(() => loadHosts())
                .catch((e) => toast(errorMessage(e), "error"))
            }
          >
            Duplicate
          </MenuItem>
          <MenuItem icon={Trash2} danger onSelect={() => void del()}>
            Delete
          </MenuItem>
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}

export function HostsView() {
  const { hosts, groups, loadAll, loadGroups, loadHosts } = useData();
  const [selected, setSelected] = useState(ALL);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Host | null>(null);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [quick, setQuick] = useState("");

  const filtered = useMemo(() => {
    const ids = selected === ALL ? null : descendants(groups, selected);
    const q = query.trim().toLowerCase();
    return hosts.filter((h) => {
      if (ids && !(h.groupId && ids.has(h.groupId))) return false;
      if (!q) return true;
      return [h.label, h.hostname, h.username, ...h.tags, h.notes].some((v) => v.toLowerCase().includes(q));
    });
  }, [hosts, groups, selected, query]);

  const deleteGroup = async (g: Group) => {
    if (!(await confirmDialog({ title: `Delete group "${g.name}"?`, message: "Hosts and sub-groups move to the parent group.", danger: true, confirmLabel: "Delete" })))
      return;
    await api.groupDelete(g.id);
    if (selected === g.id) setSelected(ALL);
    await Promise.all([loadGroups(), loadHosts()]);
  };

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

  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 overflow-y-auto border-r border-line bg-panel/50 p-2">
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Groups</span>
          <Button
            size="icon"
            variant="ghost"
            title="New group"
            onClick={() =>
              setEditingGroup({ id: "", name: "", parentId: selected === ALL ? null : selected, icon: null, color: null, sortOrder: 0, updatedAt: 0, deletedAt: null })
            }
          >
            <FolderPlus size={15} />
          </Button>
        </div>
        <GroupTree groups={groups} hosts={hosts} selected={selected} onSelect={setSelected} onEdit={setEditingGroup} onDelete={(g) => void deleteGroup(g)} />
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto p-5">
        <form
          className="mb-4 flex items-center gap-2 rounded-xl border border-line bg-panel p-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (quickConnect(quick)) setQuick("");
            else toast("Use the form user@host:port", "error");
          }}
        >
          <Zap size={16} className="ml-1 text-accent" />
          <input
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            placeholder="Quick connect: user@host:port"
            spellCheck={false}
            className="flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted"
          />
          <Button size="sm" variant="primary" type="submit" disabled={!quick.trim()}>
            Connect
          </Button>
        </form>

        <div className="mb-4 flex items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search hosts, tags…" className="pl-8" />
          </div>
          <div className="flex-1" />
          <Button onClick={() => void importSsh()} title="Import from ~/.ssh/config">
            <FileInput size={14} /> Import SSH config
          </Button>
          <Button variant="primary" onClick={() => setEditing(emptyHost(selected === ALL ? null : selected))}>
            <Plus size={14} /> New host
          </Button>
        </div>

        {filtered.length === 0 ? (
          <Empty icon={<Server size={36} />} title={hosts.length === 0 ? "No hosts yet" : "No matching hosts"}>
            {hosts.length === 0 ? "Add a host, import your ~/.ssh/config, or use quick connect above." : "Try a different search or group."}
          </Empty>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
            {filtered.map((h) => (
              <HostCard key={h.id} host={h} onEdit={() => setEditing(h)} />
            ))}
          </div>
        )}
      </section>

      <HostEditor host={editing} onClose={() => setEditing(null)} />
      <GroupEditor group={editingGroup} onClose={() => setEditingGroup(null)} />
    </div>
  );
}

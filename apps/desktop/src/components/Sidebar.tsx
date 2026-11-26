import { useState } from "react";
import * as CM from "@radix-ui/react-context-menu";
import {
  Server,
  Code2,
  KeyRound,
  ShieldCheck,
  History,
  Settings as SettingsIcon,
  Lock,
  Plus,
  Zap,
  Cloud,
  CloudOff,
  RefreshCw,
  Pencil,
  Trash2,
} from "lucide-react";
import { useApp } from "../stores/app";
import { groupColor, groupHostCount, PALETTE, useData } from "../stores/data";
import { confirmDialog, toast, useUi, type View } from "../stores/ui";
import { api, errorMessage } from "../lib/api";
import { cn, isMac, timeAgo } from "../lib/utils";
import type { Group } from "../lib/types";
import { GroupEditor } from "../views/HostEditor";
import { Caption, Kbd } from "./ui";

const NAV: { id: View; label: string; icon: typeof Server }[] = [
  { id: "hosts", label: "Hosts", icon: Server },
  { id: "snippets", label: "Snippets", icon: Code2 },
  { id: "keychain", label: "Keychain", icon: KeyRound },
  { id: "knownHosts", label: "Known hosts", icon: ShieldCheck },
  { id: "history", label: "History", icon: History },
];

function NavItem({ icon: Icon, label, count, active, onClick }: { icon: typeof Server; label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition-colors",
        active ? "bg-panel-2 font-semibold text-fg" : "text-fg-2 hover:bg-panel-2/60 hover:text-fg",
      )}
    >
      <Icon size={18} className={active ? "text-accent" : undefined} />
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && <span className="font-mono text-xs text-muted">{count}</span>}
    </button>
  );
}

function GroupItem({ group, depth, color, onEdit, onDelete }: { group: Group; depth: number; color: string; onEdit: () => void; onDelete: () => void }) {
  const { hosts, groups } = useData();
  const { view, hostGroup, setHostGroup, setView } = useUi();
  const [dragOver, setDragOver] = useState(false);
  const active = view === "hosts" && hostGroup === group.id;
  return (
    <CM.Root>
      <CM.Trigger asChild>
        <button
          onClick={() => {
            setView("hosts");
            setHostGroup(active ? null : group.id);
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("termindo/host")) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            setDragOver(false);
            const host = hosts.find((h) => h.id === e.dataTransfer.getData("termindo/host"));
            if (host)
              void api
                .hostSave({ ...host, groupId: group.id })
                .then(() => useData.getState().loadHosts())
                .catch((err) => toast(errorMessage(err), "error"));
          }}
          className={cn(
            "flex h-8 w-full items-center gap-3 rounded-lg pr-3 text-left text-[13px] transition-colors",
            active ? "bg-panel-2 text-fg" : "text-fg-2 hover:bg-panel-2/60 hover:text-fg",
            dragOver && "bg-accent/15 text-fg",
          )}
          style={{ paddingLeft: 12 + depth * 14 }}
        >
          <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: color }} />
          <span className="flex-1 truncate">{group.name}</span>
          <span className="font-mono text-xs text-muted">{groupHostCount(groups, hosts, group.id)}</span>
        </button>
      </CM.Trigger>
      <CM.Portal>
        <CM.Content className="z-50 min-w-[160px] rounded-lg border border-line bg-panel-2 p-1 shadow-xl">
          <CM.Item onSelect={onEdit} className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-panel-3">
            <Pencil size={14} /> Edit group
          </CM.Item>
          <CM.Item
            onSelect={onDelete}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-danger outline-none data-[highlighted]:bg-panel-3"
          >
            <Trash2 size={14} /> Delete group
          </CM.Item>
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}

function Groups() {
  const { groups, loadGroups, loadHosts } = useData();
  const { hostGroup, setHostGroup } = useUi();
  const [editing, setEditing] = useState<Group | null>(null);

  const remove = async (g: Group) => {
    if (!(await confirmDialog({ title: `Delete group "${g.name}"?`, message: "Hosts and sub-groups move to the parent group.", danger: true, confirmLabel: "Delete" })))
      return;
    try {
      await api.groupDelete(g.id);
      if (hostGroup === g.id) setHostGroup(null);
      await Promise.all([loadGroups(), loadHosts()]);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const render = (parentId: string | null, depth: number): React.ReactNode =>
    groups
      .filter((g) => (g.parentId ?? null) === parentId)
      .map((g) => (
        <div key={g.id} className="flex flex-col gap-0.5">
          <GroupItem
            group={g}
            depth={depth}
            color={groupColor(groups, g.id) ?? PALETTE[0]}
            onEdit={() => setEditing(g)}
            onDelete={() => void remove(g)}
          />
          {render(g.id, depth + 1)}
        </div>
      ));

  return (
    <div className="flex min-h-0 flex-col gap-0.5">
      <div className="flex items-center px-3 pb-1.5">
        <Caption className="flex-1">Groups</Caption>
        <button
          title="New group"
          className="rounded p-0.5 text-muted hover:bg-panel-2 hover:text-fg"
          onClick={() =>
            setEditing({ id: "", name: "", parentId: null, icon: null, color: null, sortOrder: 0, updatedAt: 0, deletedAt: null })
          }
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {groups.length === 0 ? <div className="px-3 py-1 text-xs text-muted">No groups yet</div> : render(null, 0)}
      </div>
      <GroupEditor group={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function SyncCard() {
  const account = useApp((s) => s.account);
  const setView = useUi((s) => s.setView);
  const signedIn = !!account?.signedIn;
  const st = account?.status;
  const status = !signedIn
    ? "Sync off"
    : st?.syncing
      ? "Syncing…"
      : st?.lastError
        ? "Sync failed"
        : `Synced · ${timeAgo(account?.lastSyncedAt)}`;
  const sync = () => {
    if (!signedIn) return setView("settings");
    void api
      .syncNow()
      .then(() => useApp.getState().refreshAccount())
      .catch((e) => toast(errorMessage(e), "error"));
  };
  return (
    <div className="flex items-center gap-2.5 rounded-[10px] bg-panel-2 p-3">
      <button onClick={sync} title={st?.lastError ?? (signedIn ? "Sync now" : "Set up sync")} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        {st?.syncing ? (
          <RefreshCw size={18} className="shrink-0 animate-spin text-accent" />
        ) : !signedIn || st?.lastError ? (
          <CloudOff size={18} className={cn("shrink-0", st?.lastError ? "text-danger" : "text-muted")} />
        ) : (
          <Cloud size={18} className="shrink-0 text-ok" />
        )}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13px] font-semibold text-fg">{status}</span>
          <span className="truncate text-xs text-muted">{signedIn ? account?.email : "Local vault only"}</span>
        </span>
      </button>
      <button
        onClick={() => void useApp.getState().lock()}
        title={`Lock (${isMac ? "⌘" : "Ctrl"}+Shift+L)`}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-panel-3 text-fg-2 hover:text-fg"
      >
        <Lock size={14} />
      </button>
    </div>
  );
}

export function Sidebar() {
  const { view, setView, setHostGroup, setPaletteOpen } = useUi();
  const { hosts, snippets, credentials, knownHosts } = useData();
  const counts: Partial<Record<View, number>> = {
    hosts: hosts.length,
    snippets: snippets.length,
    keychain: credentials.length,
    knownHosts: knownHosts.length,
  };
  return (
    <nav className="flex w-[248px] shrink-0 flex-col gap-5 bg-panel p-4">
      <div className="flex items-center gap-2.5 p-1">
        <img src="/logo.svg" alt="" className="h-7 w-7" />
        <span className="text-[17px] font-bold text-fg">Termindo</span>
      </div>

      <button
        onClick={() => setPaletteOpen(true)}
        className="flex h-9 items-center gap-2.5 rounded-lg bg-panel-2 px-2.5 text-left text-[13px] text-muted transition-colors hover:text-fg-2"
      >
        <Zap size={16} className="text-accent" />
        <span className="flex-1">Quick connect</span>
        <Kbd>{isMac ? "⌘ K" : "Ctrl K"}</Kbd>
      </button>

      <div className="flex flex-col gap-0.5">
        {NAV.map((n) => (
          <NavItem
            key={n.id}
            icon={n.icon}
            label={n.label}
            count={counts[n.id]}
            active={view === n.id}
            onClick={() => {
              if (n.id === "hosts" && view === "hosts") setHostGroup(null);
              setView(n.id);
            }}
          />
        ))}
      </div>

      <Groups />

      <div className="flex-1" />

      <div className="flex flex-col gap-3">
        <NavItem icon={SettingsIcon} label="Settings" active={view === "settings"} onClick={() => setView("settings")} />
        <SyncCard />
      </div>
    </nav>
  );
}

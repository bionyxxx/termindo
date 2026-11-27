import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as CM from "@radix-ui/react-context-menu";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Eye,
  EyeOff,
  File,
  FilePlus,
  FileSymlink,
  Folder,
  FolderPlus,
  HardDrive,
  Home,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
  Trash2,
  Upload,
  X,
  FileEdit,
} from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { dropZone, startDrag } from "../lib/drag";
import { PromptedSecrets } from "../lib/secrets";
import { cn, formatBytes, joinRemote, parentRemote, permString } from "../lib/utils";
import { useSettings } from "../stores/settings";
import { confirmDialog, promptInput, toast } from "../stores/ui";
import { useTransfers } from "../stores/transfers";
import { useWorkspace, type SftpTab } from "../stores/workspace";
import type { LocalEntry, RemoteEntry, TransferInfo } from "../lib/types";
import { Button, Dialog, Input } from "../components/ui";

type Row = { name: string; path: string; isDir: boolean; size: number; mtime: number | null; permissions?: number | null; owner?: string | null; isSymlink?: boolean };

function fmtTime(sec: number | null) {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ChmodDialog({ entry, onClose, onApply }: { entry: RemoteEntry; onClose: () => void; onApply: (mode: number) => void }) {
  const [mode, setMode] = useState(entry.permissions ?? 0o644);
  const bits = ["Owner", "Group", "Others"];
  const perms = ["Read", "Write", "Execute"];
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Permissions: ${entry.name}`}
      width="max-w-sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => onApply(mode)}>
            Apply
          </Button>
        </>
      }
    >
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-muted">
            <th />
            {perms.map((p) => (
              <th key={p} className="pb-2 font-normal">
                {p}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bits.map((who, wi) => (
            <tr key={who}>
              <td className="py-1 text-muted">{who}</td>
              {perms.map((_, pi) => {
                const bit = 1 << (8 - (wi * 3 + pi));
                return (
                  <td key={pi} className="text-center">
                    <input type="checkbox" checked={(mode & bit) !== 0} onChange={(e) => setMode(e.target.checked ? mode | bit : mode & ~bit)} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex items-center gap-2">
        <span className="text-xs text-muted">Octal</span>
        <Input
          className="w-24 font-mono"
          value={mode.toString(8).padStart(3, "0")}
          onChange={(e) => {
            const v = parseInt(e.target.value, 8);
            if (!Number.isNaN(v) && v <= 0o7777) setMode(v);
          }}
        />
        <span className="font-mono text-xs text-muted">{permString(mode, entry.isDir)}</span>
      </div>
    </Dialog>
  );
}

function MenuItem({ icon: Icon, children, onSelect, danger }: { icon: typeof File; children: React.ReactNode; onSelect: () => void; danger?: boolean }) {
  return (
    <CM.Item
      onSelect={onSelect}
      className={cn("flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] outline-none data-[highlighted]:bg-hover", danger && "text-danger")}
    >
      <Icon size={14} /> {children}
    </CM.Item>
  );
}

function FileTable({
  rows,
  remote,
  selected,
  setSelected,
  onOpen,
  menu,
  onDropItems,
  dragType,
}: {
  rows: Row[];
  remote: boolean;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  onOpen: (r: Row) => void;
  menu: (r: Row) => React.ReactNode;
  onDropItems: (data: string, targetDir: string | null) => void;
  dragType: string;
}) {
  const lastClicked = useRef<number>(-1);
  const acceptType = dragType === "termindo/remote" ? "termindo/local" : "termindo/remote";

  const click = (e: React.MouseEvent, i: number, r: Row) => {
    const next = new Set(e.ctrlKey || e.metaKey ? selected : []);
    if (e.shiftKey && lastClicked.current >= 0) {
      const [a, b] = [Math.min(lastClicked.current, i), Math.max(lastClicked.current, i)];
      for (let k = a; k <= b; k++) next.add(rows[k].path);
    } else if ((e.ctrlKey || e.metaKey) && selected.has(r.path)) {
      next.delete(r.path);
    } else {
      next.add(r.path);
    }
    lastClicked.current = i;
    setSelected(next);
  };

  return (
    <div
      ref={dropZone(acceptType, (data) => onDropItems(data, null))}
      className="min-h-0 flex-1 overflow-auto data-drag-over:bg-accent/5 data-drag-over:outline data-drag-over:-outline-offset-2 data-drag-over:outline-accent"
    >
      <table className="w-full table-fixed text-[12.5px]">
        <thead className="sticky top-0 z-[1] bg-panel text-left text-[11px] text-muted">
          <tr>
            <th className="px-3 py-1.5 font-medium">Name</th>
            <th className="w-20 px-2 py-1.5 text-right font-medium">Size</th>
            <th className="w-36 px-2 py-1.5 font-medium">Modified</th>
            {remote && <th className="w-24 px-2 py-1.5 font-medium">Perms</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <CM.Root key={r.path}>
              <CM.Trigger asChild>
                <tr
                  ref={r.isDir ? dropZone(acceptType, (data) => onDropItems(data, r.path)) : undefined}
                  onPointerDown={(e) =>
                    startDrag(e, dragType, () => {
                      const paths = selected.has(r.path) ? rows.filter((x) => selected.has(x.path)) : [r];
                      return {
                        data: JSON.stringify(paths.map((p) => ({ path: p.path, isDir: p.isDir }))),
                        label: paths.length > 1 ? `${paths.length} items` : r.name,
                      };
                    })
                  }
                  onClick={(e) => click(e, i, r)}
                  onContextMenu={() => !selected.has(r.path) && setSelected(new Set([r.path]))}
                  onDoubleClick={() => onOpen(r)}
                  className={cn(
                    "cursor-default border-b border-line/40",
                    selected.has(r.path) ? "bg-accent/15" : "hover:bg-hover/60",
                    "data-drag-over:bg-accent/25!",
                  )}
                >
                  <td className="truncate px-3 py-1">
                    <span className="flex items-center gap-2">
                      {r.isDir ? (
                        <Folder size={14} className="shrink-0 text-accent" />
                      ) : r.isSymlink ? (
                        <FileSymlink size={14} className="shrink-0 text-muted" />
                      ) : (
                        <File size={14} className="shrink-0 text-muted" />
                      )}
                      <span className="truncate">{r.name}</span>
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right text-muted">{r.isDir ? "" : formatBytes(r.size)}</td>
                  <td className="truncate px-2 py-1 text-muted">{fmtTime(r.mtime)}</td>
                  {remote && <td className="px-2 py-1 font-mono text-[11px] text-muted">{permString(r.permissions ?? null, r.isDir)}</td>}
                </tr>
              </CM.Trigger>
              <CM.Portal>
                <CM.Content className="z-50 min-w-[180px] rounded-lg border border-line bg-panel p-1 shadow-xl">{menu(r)}</CM.Content>
              </CM.Portal>
            </CM.Root>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-10 text-center text-xs text-muted">Empty folder</div>}
    </div>
  );
}

function PathBar({
  icon,
  path,
  onNavigate,
  children,
}: {
  icon: React.ReactNode;
  path: string;
  onNavigate: (p: string) => void;
  children?: React.ReactNode;
}) {
  const [value, setValue] = useState(path);
  useEffect(() => setValue(path), [path]);
  return (
    <div className="flex items-center gap-1 border-b border-line bg-panel px-2 py-1.5">
      {icon}
      <form
        className="min-w-0 flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          onNavigate(value);
        }}
      >
        <input value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} className="w-full rounded bg-bg px-2 py-1 font-mono text-[12px] outline-none focus:ring-1 focus:ring-accent" />
      </form>
      {children}
    </div>
  );
}

function TransferRow({ t }: { t: TransferInfo }) {
  const pct = t.size > 0 ? Math.min(100, (t.transferred / t.size) * 100) : t.state === "done" ? 100 : 0;
  return (
    <div className="flex items-center gap-3 border-b border-line/50 px-3 py-1.5 text-[12px]">
      {t.direction === "upload" ? <Upload size={13} className="text-accent" /> : <Download size={13} className="text-ok" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate" title={t.direction === "upload" ? t.remotePath : t.localPath}>
            {t.name}
          </span>
          <span className="ml-auto shrink-0 text-[11px] text-muted">
            {t.state === "running"
              ? `${formatBytes(t.transferred)} / ${formatBytes(t.size)} · ${formatBytes(t.speed)}/s`
              : t.state === "error"
                ? <span className="text-danger" title={t.error ?? ""}>error: {t.error}</span>
                : `${t.state} · ${formatBytes(t.size)}`}
          </span>
        </div>
        <div className="mt-1 h-1 overflow-hidden rounded bg-line">
          <div
            className={cn("h-full transition-[width]", t.state === "error" ? "bg-danger" : t.state === "done" ? "bg-ok" : t.state === "paused" ? "bg-warn" : "bg-accent")}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="flex shrink-0 gap-0.5">
        {(t.state === "queued" || t.state === "paused") && (
          <>
            <button title="Higher priority" className="rounded p-1 text-muted hover:bg-hover hover:text-fg" onClick={() => void api.transferSetPriority(t.id, t.priority + 1)}>
              <ChevronUp size={13} />
            </button>
            <button title="Lower priority" className="rounded p-1 text-muted hover:bg-hover hover:text-fg" onClick={() => void api.transferSetPriority(t.id, t.priority - 1)}>
              <ChevronDown size={13} />
            </button>
          </>
        )}
        {(t.state === "running" || t.state === "queued") && (
          <button title="Pause" className="rounded p-1 text-muted hover:bg-hover hover:text-fg" onClick={() => void api.transferPause(t.id)}>
            <Pause size={13} />
          </button>
        )}
        {t.state === "paused" && (
          <button title="Resume" className="rounded p-1 text-muted hover:bg-hover hover:text-fg" onClick={() => void api.transferResume(t.id)}>
            <Play size={13} />
          </button>
        )}
        {t.state === "error" && (
          <button title="Retry (resumes)" className="rounded p-1 text-muted hover:bg-hover hover:text-fg" onClick={() => void api.transferResume(t.id)}>
            <RotateCcw size={13} />
          </button>
        )}
        {t.state !== "done" && t.state !== "cancelled" && (
          <button title="Cancel" className="rounded p-1 text-muted hover:bg-hover hover:text-danger" onClick={() => void api.transferCancel(t.id)}>
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

function TransferPanel({ sftpId }: { sftpId: string }) {
  const items = useTransfers((s) => s.items);
  const clearFinished = useTransfers((s) => s.clearFinished);
  const [open, setOpen] = useState(true);
  const list = useMemo(
    () =>
      Object.values(items)
        .filter((t) => t.sftpId === sftpId)
        .sort((a, b) => {
          const rank = (x: TransferInfo) => (x.state === "running" ? 0 : x.state === "queued" ? 1 : x.state === "paused" || x.state === "error" ? 2 : 3);
          return rank(a) - rank(b) || b.priority - a.priority || a.createdAt - b.createdAt;
        }),
    [items, sftpId],
  );
  if (list.length === 0) return null;
  const active = list.filter((t) => t.state === "running" || t.state === "queued").length;
  return (
    <div className="flex shrink-0 flex-col border-t border-line bg-panel" style={{ maxHeight: open ? 220 : 32 }}>
      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-[12px]">
        <button className="flex items-center gap-1 font-medium" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />} Transfers
        </button>
        <span className="text-muted">
          {active} active · {list.length} total
        </span>
        <button className="ml-auto text-[11px] text-muted hover:text-fg" onClick={() => void clearFinished()}>
          Clear finished
        </button>
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.map((t) => (
            <TransferRow key={t.id} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

export function SftpView({ tab }: { tab: SftpTab }) {
  const sftpId = tab.id;
  const showHidden = useSettings((s) => s.settings.sftpShowHidden);
  const updateSettings = useSettings((s) => s.update);
  const [status, setStatus] = useState<"connecting" | "ready" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [remoteDir, setRemoteDir] = useState("");
  const [remoteHome, setRemoteHome] = useState("/");
  const [remoteRows, setRemoteRows] = useState<RemoteEntry[]>([]);
  const [localDir, setLocalDir] = useState("");
  const [localRows, setLocalRows] = useState<LocalEntry[]>([]);
  const [remoteSel, setRemoteSel] = useState<Set<string>>(new Set());
  const [localSel, setLocalSel] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [chmod, setChmod] = useState<RemoteEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const opened = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const secrets = useRef(new PromptedSecrets());

  const listRemote = useCallback(
    async (dir: string) => {
      setLoading(true);
      try {
        const rows = await api.sftpList(sftpId, dir);
        setRemoteRows(rows);
        setRemoteDir(dir);
        setRemoteSel(new Set());
      } catch (e) {
        toast(errorMessage(e), "error");
      } finally {
        setLoading(false);
      }
    },
    [sftpId],
  );

  const listLocal = useCallback(
    async (dir: string) => {
      try {
        setLocalRows(await api.localList(dir, showHidden));
        setLocalDir(dir);
        setLocalSel(new Set());
      } catch (e) {
        toast(errorMessage(e), "error");
      }
    },
    [showHidden],
  );

  const connect = useCallback(async () => {
    setStatus("connecting");
    setError(null);
    try {
      const r = await api.sftpOpen(sftpId, secrets.current.addTo(tab.target));
      setRemoteHome(r.home);
      setStatus("ready");
      await listRemote(r.startDir);
    } catch (e) {
      const request = secrets.current.request(e, tab.title);
      if (request) {
        const { hostId, ...prompt } = request;
        const v = await promptInput({ ...prompt, secret: true, confirmLabel: "Connect" });
        if (v !== null) {
          secrets.current.set(hostId, v);
          return connect();
        }
      }
      setStatus("error");
      setError(errorMessage(e));
    }
  }, [sftpId, tab.target, tab.title, listRemote]);

  useEffect(() => {
    clearTimeout(closeTimer.current);
    if (!opened.current) {
      opened.current = true;
      void connect();
      void api.localHome().then(listLocal);
    }
    return () => {
      // Deferred so React StrictMode's simulated unmount doesn't close the session.
      closeTimer.current = setTimeout(() => void api.sftpClose(sftpId), 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (localDir) void listLocal(localDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  const upload = useCallback(
    async (paths: string[], targetDir?: string) => {
      if (!paths.length) return;
      try {
        await api.transferUpload(sftpId, paths, targetDir ?? remoteDir);
      } catch (e) {
        toast(errorMessage(e), "error");
      }
    },
    [sftpId, remoteDir],
  );

  const download = async (items: { path: string; isDir: boolean }[], targetDir?: string) => {
    let dir = targetDir ?? localDir;
    if (!dir) {
      const picked = await open({ directory: true, title: "Download to…" });
      if (typeof picked !== "string") return;
      dir = picked;
    }
    try {
      await api.transferDownload(sftpId, items, dir);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  // Refresh panes when transfers into them finish.
  const doneCount = useTransfers((s) => Object.values(s.items).filter((t) => t.sftpId === sftpId && t.state === "done").length);
  useEffect(() => {
    if (status !== "ready" || doneCount === 0) return;
    const t = setTimeout(() => {
      void listRemote(remoteDir);
      if (localDir) void listLocal(localDir);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneCount]);

  // Files dropped from the OS file manager upload into the current remote folder.
  const activeTabId = useWorkspace((s) => s.activeTabId);
  useEffect(() => {
    if (activeTabId !== sftpId || status !== "ready") return;
    const p = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "drop" && e.payload.paths.length) void upload(e.payload.paths);
    });
    return () => void p.then((f) => f());
  }, [activeTabId, sftpId, status, upload]);

  const remoteFiltered = remoteRows.filter((r) => (showHidden || !r.name.startsWith(".")) && (!filter || r.name.toLowerCase().includes(filter.toLowerCase())));
  const localFiltered = localRows.filter((r) => !filter || r.name.toLowerCase().includes(filter.toLowerCase()));
  const selectedRemote = remoteRows.filter((r) => remoteSel.has(r.path));
  const selectedLocal = localRows.filter((r) => localSel.has(r.path));

  const mkdir = async () => {
    const name = await promptInput({ title: "New folder", label: "Name", confirmLabel: "Create" });
    if (!name) return;
    try {
      await api.sftpMkdir(sftpId, joinRemote(remoteDir, name));
      await listRemote(remoteDir);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const mkfile = async () => {
    const name = await promptInput({ title: "New file", label: "Name", confirmLabel: "Create" });
    if (!name) return;
    try {
      await api.sftpCreateFile(sftpId, joinRemote(remoteDir, name));
      await listRemote(remoteDir);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const rename = async (r: RemoteEntry) => {
    const name = await promptInput({ title: "Rename", label: "New name", defaultValue: r.name, confirmLabel: "Rename" });
    if (!name || name === r.name) return;
    try {
      await api.sftpRename(sftpId, r.path, joinRemote(parentRemote(r.path), name));
      await listRemote(remoteDir);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const remove = async (rows: RemoteEntry[]) => {
    if (!rows.length) return;
    const dirs = rows.filter((r) => r.isDir).length;
    if (
      !(await confirmDialog({
        title: `Delete ${rows.length === 1 ? rows[0].name : `${rows.length} items`}?`,
        message: dirs ? "Folders are deleted recursively. This cannot be undone." : "This cannot be undone.",
        danger: true,
        confirmLabel: "Delete",
      }))
    )
      return;
    try {
      await api.sftpRemove(sftpId, rows.map((r) => r.path));
      await listRemote(remoteDir);
    } catch (e) {
      toast(errorMessage(e), "error");
      await listRemote(remoteDir);
    }
  };
  const edit = async (r: RemoteEntry) => {
    try {
      await api.sftpEdit(sftpId, r.path);
      toast(`Opened ${r.name}. Saving the file uploads it back automatically.`, "info");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  if (status !== "ready") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted">
        {status === "connecting" ? (
          <>
            <RefreshCw className="animate-spin" /> Connecting SFTP to {tab.title}…
          </>
        ) : (
          <>
            <div className="text-danger">{error}</div>
            <Button onClick={() => void connect()}>
              <RefreshCw size={14} /> Retry
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className="h-7 w-56" />
        <Button size="sm" variant="ghost" onClick={() => updateSettings({ sftpShowHidden: !showHidden })} title="Show hidden files">
          {showHidden ? <Eye size={14} /> : <EyeOff size={14} />} Hidden
        </Button>
        <div className="flex-1" />
        <Button size="sm" disabled={!selectedLocal.length} onClick={() => void upload(selectedLocal.map((r) => r.path))}>
          <Upload size={13} /> Upload →
        </Button>
        <Button size="sm" disabled={!selectedRemote.length} onClick={() => void download(selectedRemote.map((r) => ({ path: r.path, isDir: r.isDir })))}>
          <Download size={13} /> ← Download
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Local */}
        <div className="flex min-w-0 flex-1 flex-col border-r border-line">
          <PathBar icon={<HardDrive size={14} className="mx-1 text-muted" />} path={localDir} onNavigate={(p) => void listLocal(p)}>
            <Button size="icon" variant="ghost" title="Up" onClick={() => void api.localParent(localDir).then(listLocal)}>
              <ArrowUp size={14} />
            </Button>
            <Button size="icon" variant="ghost" title="Home" onClick={() => void api.localHome().then(listLocal)}>
              <Home size={14} />
            </Button>
            <Button size="icon" variant="ghost" title="Refresh" onClick={() => void listLocal(localDir)}>
              <RefreshCw size={14} />
            </Button>
          </PathBar>
          <FileTable
            rows={localFiltered}
            remote={false}
            selected={localSel}
            setSelected={setLocalSel}
            dragType="termindo/local"
            onOpen={(r) => (r.isDir ? void listLocal(r.path) : void api.openLocal(r.path))}
            onDropItems={(data, target) => {
              const items = JSON.parse(data) as { path: string; isDir: boolean }[];
              void download(items, target ?? localDir);
            }}
            menu={(r) => (
              <>
                {r.isDir ? (
                  <MenuItem icon={Folder} onSelect={() => void listLocal(r.path)}>
                    Open
                  </MenuItem>
                ) : (
                  <MenuItem icon={File} onSelect={() => void api.openLocal(r.path)}>
                    Open with default app
                  </MenuItem>
                )}
                <MenuItem icon={Upload} onSelect={() => void upload(localSel.has(r.path) ? [...localSel] : [r.path])}>
                  Upload to {remoteDir}
                </MenuItem>
                <MenuItem icon={Copy} onSelect={() => void writeText(r.path)}>
                  Copy path
                </MenuItem>
              </>
            )}
          />
        </div>

        {/* Remote */}
        <div className="flex min-w-0 flex-1 flex-col">
          <PathBar icon={<Server size={14} className="mx-1 text-accent" />} path={remoteDir} onNavigate={(p) => void listRemote(p)}>
            <Button size="icon" variant="ghost" title="Up" onClick={() => void listRemote(parentRemote(remoteDir))}>
              <ArrowUp size={14} />
            </Button>
            <Button size="icon" variant="ghost" title="Home" onClick={() => void listRemote(remoteHome)}>
              <Home size={14} />
            </Button>
            <Button size="icon" variant="ghost" title="Refresh" onClick={() => void listRemote(remoteDir)}>
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </Button>
            <Button size="icon" variant="ghost" title="New folder" onClick={() => void mkdir()}>
              <FolderPlus size={14} />
            </Button>
            <Button size="icon" variant="ghost" title="New file" onClick={() => void mkfile()}>
              <FilePlus size={14} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              title="Upload files…"
              onClick={() =>
                void open({ multiple: true, title: "Upload files" }).then((p) => {
                  if (Array.isArray(p)) void upload(p);
                  else if (typeof p === "string") void upload([p]);
                })
              }
            >
              <Upload size={14} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              title="Upload folder…"
              onClick={() =>
                void open({ directory: true, title: "Upload folder" }).then((p) => {
                  if (typeof p === "string") void upload([p]);
                })
              }
            >
              <FolderPlus size={14} className="text-accent" />
            </Button>
          </PathBar>
          <FileTable
            rows={remoteFiltered}
            remote
            selected={remoteSel}
            setSelected={setRemoteSel}
            dragType="termindo/remote"
            onOpen={(r) => (r.isDir ? void listRemote(r.path) : void edit(r as RemoteEntry))}
            onDropItems={(data, target) => {
              const items = JSON.parse(data) as { path: string }[];
              void upload(
                items.map((i) => i.path),
                target ?? remoteDir,
              );
            }}
            menu={(row) => {
              const r = row as RemoteEntry;
              const targets = remoteSel.has(r.path) ? selectedRemote : [r];
              return (
                <>
                  {r.isDir ? (
                    <MenuItem icon={Folder} onSelect={() => void listRemote(r.path)}>
                      Open
                    </MenuItem>
                  ) : (
                    <MenuItem icon={FileEdit} onSelect={() => void edit(r)}>
                      Edit in local editor
                    </MenuItem>
                  )}
                  <MenuItem icon={Download} onSelect={() => void download(targets.map((t) => ({ path: t.path, isDir: t.isDir })))}>
                    Download {targets.length > 1 ? `${targets.length} items` : ""}
                  </MenuItem>
                  <CM.Separator className="my-1 h-px bg-line" />
                  <MenuItem icon={Pencil} onSelect={() => void rename(r)}>
                    Rename
                  </MenuItem>
                  <MenuItem icon={ShieldCheck} onSelect={() => setChmod(r)}>
                    Permissions…
                  </MenuItem>
                  <MenuItem icon={Copy} onSelect={() => void writeText(r.path)}>
                    Copy path
                  </MenuItem>
                  <CM.Separator className="my-1 h-px bg-line" />
                  <MenuItem icon={Trash2} danger onSelect={() => void remove(targets)}>
                    Delete
                  </MenuItem>
                </>
              );
            }}
          />
        </div>
      </div>

      <TransferPanel sftpId={sftpId} />
      {chmod && (
        <ChmodDialog
          entry={chmod}
          onClose={() => setChmod(null)}
          onApply={(mode) => {
            const e = chmod;
            setChmod(null);
            void api
              .sftpChmod(sftpId, e.path, mode)
              .then(() => listRemote(remoteDir))
              .catch((err) => toast(errorMessage(err), "error"));
          }}
        />
      )}
    </div>
  );
}

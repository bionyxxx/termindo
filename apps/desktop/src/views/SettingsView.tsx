import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Cloud, Download, LogOut, MonitorSmartphone, RefreshCw, Trash2, Upload } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useApp } from "../stores/app";
import { useData } from "../stores/data";
import { DEFAULT_SETTINGS, useSettings } from "../stores/settings";
import { confirmDialog, toast } from "../stores/ui";
import { TERMINAL_THEMES } from "../terminal/themes";
import type { Device, UpdateInfo } from "../lib/types";
import { openRelease } from "../lib/updates";
import { Badge, Button, Field, Input, Select, Switch } from "../components/ui";
import { cn, timeAgo } from "../lib/utils";

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      <div className="mt-4 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function ThemePreview({ id, selected, onClick }: { id: string; selected: boolean; onClick: () => void }) {
  const t = TERMINAL_THEMES.find((x) => x.id === id)!;
  const c = t.colors;
  return (
    <button
      onClick={onClick}
      className={cn("overflow-hidden rounded-lg border-2 text-left", selected ? "border-accent" : "border-line hover:border-muted")}
    >
      <div className="p-2 font-mono text-[10.5px] leading-4" style={{ background: c.background, color: c.foreground }}>
        <div>
          <span style={{ color: c.green }}>user@host</span>:<span style={{ color: c.blue }}>~</span>$ ls
        </div>
        <div>
          <span style={{ color: c.cyan }}>docs</span> <span style={{ color: c.yellow }}>run.sh</span> <span style={{ color: c.red }}>x.log</span>
        </div>
      </div>
      <div className="bg-panel-2 px-2 py-1 text-[11px]">{t.name}</div>
    </button>
  );
}

function AccountSection() {
  const { account, refreshAccount, vault, refreshVault } = useApp();
  const defaultServer = useSettings((s) => s.settings.defaultServerUrl);
  const [server, setServer] = useState(account?.serverUrl ?? defaultServer);
  const [email, setEmail] = useState(account?.email ?? "");
  const [password, setPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<Device[] | null>(null);

  useEffect(() => {
    if (account?.signedIn) void api.accountDevices().then(setDevices).catch(() => setDevices(null));
  }, [account?.signedIn]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
      await refreshAccount();
    }
  };

  if (account?.signedIn) {
    const st = account.status;
    return (
      <Section title="Sync account" description="Hosts, groups, keys, snippets and known hosts are encrypted on this device before upload.">
        <div className="flex items-center gap-3 rounded-lg border border-line bg-bg p-3">
          <Cloud size={20} className={st.lastError ? "text-danger" : "text-ok"} />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{account.email}</div>
            <div className="truncate text-[11px] text-muted">
              {account.serverUrl} · {st.syncing ? "syncing…" : `last sync ${timeAgo(account.lastSyncedAt)}`}
            </div>
            {st.lastError && <div className="text-[11px] text-danger">{st.lastError}</div>}
          </div>
          <Button
            size="sm"
            loading={busy}
            onClick={() =>
              void act(async () => {
                const r = await api.syncNow();
                if (r) toast(`Sync done: ${r.pushed} sent, ${r.applied} received`, "success");
                await useData.getState().loadAll();
              })
            }
          >
            <RefreshCw size={13} /> Sync now
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              void act(async () => {
                if (await confirmDialog({ title: "Sign out?", message: "Local data stays on this device; sync stops.", confirmLabel: "Sign out" }))
                  await api.accountLogout();
              })
            }
          >
            <LogOut size={13} /> Sign out
          </Button>
        </div>
        <div>
          <div className="mb-2 text-xs font-medium text-muted">Devices</div>
          <div className="flex flex-col gap-1">
            {(devices ?? []).map((d) => (
              <div key={d.id} className="flex items-center gap-3 rounded-md border border-line bg-bg px-3 py-2">
                <MonitorSmartphone size={16} className="text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    {d.name} {d.current && <Badge className="ml-1 text-accent">this device</Badge>}
                  </div>
                  <div className="text-[11px] text-muted">last seen {timeAgo(d.last_seen_at)}</div>
                </div>
                {!d.current && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void act(async () => {
                        if (!(await confirmDialog({ title: `Revoke ${d.name}?`, message: "It will be signed out immediately.", danger: true, confirmLabel: "Revoke" }))) return;
                        await api.accountRevokeDevice(d.id);
                        setDevices(await api.accountDevices());
                      })
                    }
                  >
                    <Trash2 size={13} /> Revoke
                  </Button>
                )}
              </div>
            ))}
            {devices === null && <div className="text-xs text-muted">Device list unavailable.</div>}
          </div>
        </div>
      </Section>
    );
  }

  return (
    <Section
      title="Sync account"
      description="Optional. Sync with your own Termindo server (see deploy/ for a Docker setup). Your master password is the account password, and the server only stores ciphertext."
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Server URL" className="col-span-2">
          <Input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://sync.example.com" />
        </Field>
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Master password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Recovery key (optional, register only)" className="col-span-2" hint="Enables resetting the account password with your recovery key.">
          <Input value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} className="font-mono" />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button
          variant="primary"
          loading={busy}
          disabled={!email || !password}
          onClick={() =>
            void act(async () => {
              await api.accountRegister(server, email, password, recoveryKey || undefined);
              setPassword("");
              toast("Account created. Syncing…", "success");
            })
          }
        >
          Create account
        </Button>
        <Button
          loading={busy}
          disabled={!email || !password}
          onClick={() =>
            void act(async () => {
              if (
                !(await confirmDialog({
                  title: "Sign in and merge?",
                  message:
                    "Your local data will be merged with the account. If the account uses a different master password, this vault adopts the account's password.",
                  confirmLabel: "Sign in",
                }))
              )
                return;
              await api.accountLogin(server, email, password);
              setPassword("");
              await refreshVault();
              await useData.getState().loadAll();
              toast("Signed in. Syncing…", "success");
            })
          }
        >
          Sign in to existing
        </Button>
      </div>
      {vault?.initialized === false && <p className="text-xs text-warn">Create a vault first.</p>}
    </Section>
  );
}

function SecuritySection() {
  const { settings, update } = useSettings();
  const { vault, refreshVault } = useApp();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const change = async () => {
    if (next.length < 8) return toast("Use at least 8 characters", "error");
    if (next !== confirm) return toast("Passwords do not match", "error");
    setBusy(true);
    try {
      await api.vaultChangePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast("Master password changed", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Security">
      <Field label="Auto-lock after inactivity">
        <Select value={settings.autoLockMinutes} onChange={(e) => update({ autoLockMinutes: Number(e.target.value) })}>
          {[0, 5, 15, 30, 60, 240].map((m) => (
            <option key={m} value={m}>
              {m === 0 ? "Never" : `${m} minutes`}
            </option>
          ))}
        </Select>
      </Field>
      <Switch
        checked={!!vault?.keychainEnabled}
        onChange={(v) =>
          void api
            .vaultSetKeychain(v)
            .then(refreshVault)
            .catch((e) => toast(errorMessage(e), "error"))
        }
        label="Unlock with OS keychain"
        hint="Store the vault key in the system keychain (Keychain / Credential Manager / Secret Service) so you don't type the master password at startup."
      />
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Field label="Current password">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Confirm">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
      </div>
      <Button className="self-start" loading={busy} disabled={!current || !next} onClick={() => void change()}>
        Change master password
      </Button>
    </Section>
  );
}

function DataSection() {
  const loadAll = useData((s) => s.loadAll);
  const run = async (fn: () => Promise<string | void>) => {
    try {
      const msg = await fn();
      if (msg) toast(msg, "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    <Section title="Import & export" description="Backups contain hosts, groups, snippets and known hosts, never passwords or keys.">
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            void run(async () => {
              const r = await api.importSshConfig();
              await loadAll();
              return `Imported ${r.hosts} hosts, ${r.keys} keys (${r.skipped} skipped)`;
            })
          }
        >
          <Upload size={14} /> Import ~/.ssh/config
        </Button>
        <Button
          onClick={() =>
            void run(async () => {
              const path = await open({ multiple: false, title: "Select an OpenSSH config file" });
              if (typeof path !== "string") return;
              const r = await api.importSshConfig(path);
              await loadAll();
              return `Imported ${r.hosts} hosts, ${r.keys} keys`;
            })
          }
        >
          <Upload size={14} /> Import SSH config file…
        </Button>
        <Button
          onClick={() =>
            void run(async () => {
              const path = await open({ multiple: false, title: "Import backup", filters: [{ name: "Termindo backup", extensions: ["json", "csv"] }] });
              if (typeof path !== "string") return;
              const r = await api.importBackup(path);
              await loadAll();
              return `Imported ${r.hosts} hosts, ${r.groups} groups, ${r.snippets} snippets`;
            })
          }
        >
          <Upload size={14} /> Import backup (JSON/CSV)…
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            void run(async () => {
              const path = await save({ defaultPath: "termindo-backup.json", filters: [{ name: "JSON", extensions: ["json"] }] });
              if (!path) return;
              await api.exportBackup(path, "json");
              return "Backup saved";
            })
          }
        >
          <Download size={14} /> Export JSON
        </Button>
        <Button
          onClick={() =>
            void run(async () => {
              const path = await save({ defaultPath: "termindo-hosts.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
              if (!path) return;
              await api.exportBackup(path, "csv");
              return "CSV saved";
            })
          }
        >
          <Download size={14} /> Export hosts CSV
        </Button>
        <Button
          onClick={() =>
            void run(async () => {
              const path = await save({ defaultPath: "ssh_config" });
              if (!path) return;
              await api.exportSshConfig(path);
              return "SSH config exported";
            })
          }
        >
          <Download size={14} /> Export as SSH config
        </Button>
      </div>
    </Section>
  );
}

function UpdatesSection() {
  const enabled = useSettings((s) => s.settings.checkUpdates);
  const update = useSettings((s) => s.update);
  const [version, setVersion] = useState<string | null>(null);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => setVersion(null));
  }, []);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await api.updateCheck());
    } catch (e) {
      setInfo(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Updates" description={version ? `Termindo ${version}` : undefined}>
      <Switch
        checked={enabled}
        onChange={(v) => update({ checkUpdates: v })}
        label="Check for updates automatically"
        hint="Looks for a new release on startup and every few hours. Nothing is installed automatically."
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void check()} loading={busy}>
          <RefreshCw size={14} /> Check now
        </Button>
        {info && !info.available && <span className="text-xs text-muted">You're on the latest version ({info.current}).</span>}
        {info?.available && (
          <>
            <span className="text-xs">
              Version <b>{info.latest}</b> is available.
            </span>
            <Button variant="primary" size="sm" onClick={() => openRelease(info)}>
              <Download size={14} /> Download
            </Button>
          </>
        )}
        {error && <span className="text-xs text-danger">Could not check: {error}</span>}
      </div>
    </Section>
  );
}

export function SettingsView() {
  const { settings, update } = useSettings();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-5">
      <Section title="Appearance">
        <Field label="App theme">
          <Select value={settings.appTheme} onChange={(e) => update({ appTheme: e.target.value as typeof settings.appTheme })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </Select>
        </Field>
        <div>
          <span className="text-xs font-medium text-muted">Terminal theme</span>
          <div className="mt-1 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {TERMINAL_THEMES.map((t) => (
              <ThemePreview key={t.id} id={t.id} selected={settings.terminalTheme === t.id} onClick={() => update({ terminalTheme: t.id })} />
            ))}
          </div>
        </div>
      </Section>

      <Section title="Terminal">
        <div className="grid grid-cols-4 gap-3">
          <Field label="Font family" className="col-span-4" hint="CSS font list; the first installed font is used.">
            <Input value={settings.fontFamily} onChange={(e) => update({ fontFamily: e.target.value || DEFAULT_SETTINGS.fontFamily })} />
          </Field>
          <Field label="Font size">
            <Input type="number" min={8} max={32} value={settings.fontSize} onChange={(e) => update({ fontSize: Number(e.target.value) || 14 })} />
          </Field>
          <Field label="Line height">
            <Input type="number" step={0.05} min={1} max={2} value={settings.lineHeight} onChange={(e) => update({ lineHeight: Number(e.target.value) || 1 })} />
          </Field>
          <Field label="Cursor">
            <Select value={settings.cursorStyle} onChange={(e) => update({ cursorStyle: e.target.value as typeof settings.cursorStyle })}>
              <option value="block">Block</option>
              <option value="bar">Bar</option>
              <option value="underline">Underline</option>
            </Select>
          </Field>
          <Field label="Scrollback lines">
            <Input type="number" min={100} max={200000} step={1000} value={settings.scrollback} onChange={(e) => update({ scrollback: Number(e.target.value) || 10000 })} />
          </Field>
        </div>
        <Switch checked={settings.cursorBlink} onChange={(v) => update({ cursorBlink: v })} label="Blinking cursor" />
        <Switch checked={settings.copyOnSelect} onChange={(v) => update({ copyOnSelect: v })} label="Copy on select" />
        <Switch checked={settings.rightClickPaste} onChange={(v) => update({ rightClickPaste: v })} label="Right-click copies selection / pastes" />
        <Switch checked={settings.confirmCloseTab} onChange={(v) => update({ confirmCloseTab: v })} label="Confirm before closing active sessions" />
        <Switch checked={settings.restoreSession} onChange={(v) => update({ restoreSession: v })} label="Restore tabs and splits on startup" />
      </Section>

      <SecuritySection />
      <AccountSection />
      <DataSection />
      <UpdatesSection />

      <Section title="Keyboard shortcuts">
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
          {[
            ["Ctrl+K", "Command palette / connect"],
            ["Ctrl+Shift+S", "Run snippet"],
            ["Ctrl+Shift+D / E", "Split right / down"],
            ["Alt+Arrows", "Move between panes"],
            ["Ctrl+Shift+W", "Close pane"],
            ["Ctrl+Tab", "Next tab"],
            ["Ctrl+1…9", "Go to tab"],
            ["Ctrl+Shift+F", "Search scrollback"],
            ["Ctrl+Shift+C / V", "Copy / paste"],
            ["Ctrl+= / − / 0", "Font size"],
            ["Ctrl+Shift+L", "Lock vault"],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-line/50 py-1">
              <span className="text-muted">{v}</span>
              <kbd className="font-mono text-[11px]">{k}</kbd>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

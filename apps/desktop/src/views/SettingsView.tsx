import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ArrowLeftRight, Cloud, Download, FileInput, FileOutput, Keyboard, KeyRound, LogOut, MonitorSmartphone, Palette, RefreshCw, Shield, SquareTerminal, Trash2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useApp } from "../stores/app";
import { useData } from "../stores/data";
import { DEFAULT_SETTINGS, useSettings } from "../stores/settings";
import { confirmDialog, toast } from "../stores/ui";
import { TERMINAL_THEMES } from "../terminal/themes";
import type { Device, UpdateInfo } from "../lib/types";
import { openRelease } from "../lib/updates";
import { Badge, Button, Caption, Dialog, Field, Input, Kbd, Select, StatusPill, Switch } from "../components/ui";
import { cn, isMac, timeAgo } from "../lib/utils";

function Section({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} className="scroll-mt-4 rounded-2xl bg-panel p-6">
      <h3 className="text-[17px] font-semibold text-fg">{title}</h3>
      {description && <p className="mt-1.5 text-[13px] text-muted">{description}</p>}
      <div className="mt-5 flex flex-col gap-4">{children}</div>
    </section>
  );
}

/** Label (+ hint) on the left, control on the right. */
function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-fg">{label}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-2.5">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-0.5 rounded-[10px] bg-panel-2 p-1">
      {options.map(([id, label]) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={cn(
            "h-7 rounded-[7px] px-3 text-[13px] transition-colors",
            value === id ? "bg-panel-3 font-semibold text-fg" : "font-medium text-fg-2 hover:text-fg",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ThemePreview({ id, selected, onClick }: { id: string; selected: boolean; onClick: () => void }) {
  const t = TERMINAL_THEMES.find((x) => x.id === id)!;
  const c = t.colors;
  return (
    <button onClick={onClick} className="group flex flex-col gap-2 text-left">
      <div
        className={cn(
          "w-full rounded-[10px] px-3 py-2.5 font-mono text-[11px] leading-[19px] outline outline-2 -outline-offset-2 transition-[outline-color]",
          selected ? "outline-accent" : "outline-transparent group-hover:outline-line",
        )}
        style={{ background: c.background, color: c.foreground }}
      >
        <div className="truncate" style={{ color: c.cyan }}>
          user@host:~$ <span style={{ color: c.foreground }}>ls</span>
        </div>
        <div className="truncate">docs&nbsp;&nbsp;src&nbsp;&nbsp;.env</div>
      </div>
      <span className={cn("truncate text-[13px]", selected ? "font-semibold text-fg" : "text-fg-2")}>{t.name}</span>
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
      <Section id="sync" title="Sync account" description="Hosts, groups, keys, snippets and known hosts are encrypted before upload.">
        <div className="flex items-center gap-3.5 rounded-xl bg-panel-2 px-4 py-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo text-base font-semibold text-white">
            {(account.email ?? "?").charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold text-fg">{account.email}</div>
            <div className="truncate font-mono text-xs text-muted">
              {(account.serverUrl ?? "").replace(/^https?:\/\//, "")}
              {devices ? ` · ${devices.length} device${devices.length === 1 ? "" : "s"}` : ""}
            </div>
          </div>
          {st.syncing ? (
            <StatusPill tone="muted">Syncing…</StatusPill>
          ) : st.lastError ? (
            <span title={st.lastError}>
              <StatusPill tone="danger">Sync failed</StatusPill>
            </span>
          ) : (
            <StatusPill tone="ok">Synced {timeAgo(account.lastSyncedAt)}</StatusPill>
          )}
          <Button
            loading={busy}
            onClick={() =>
              void act(async () => {
                const r = await api.syncNow();
                if (r) toast(`Sync done: ${r.pushed} sent, ${r.applied} received`, "success");
                await useData.getState().loadAll();
              })
            }
          >
            {!busy && <RefreshCw size={16} />} Sync now
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              void act(async () => {
                if (await confirmDialog({ title: "Sign out?", message: "Local data stays on this device; sync stops.", confirmLabel: "Sign out" }))
                  await api.accountLogout();
              })
            }
          >
            <LogOut size={16} /> Sign out
          </Button>
        </div>
        {st.lastError && <div className="rounded-lg bg-danger/12 px-3 py-2 text-xs text-danger">{st.lastError}</div>}
        <div className="flex flex-col gap-2">
          <Caption>Devices</Caption>
          <div className="flex flex-col gap-1.5">
            {(devices ?? []).map((d) => (
              <div key={d.id} className="flex items-center gap-3 rounded-lg bg-panel-2 px-3.5 py-2.5">
                <MonitorSmartphone size={16} className="text-fg-2" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 truncate text-[13px] font-medium text-fg">
                    {d.name} {d.current && <Badge className="text-accent">this device</Badge>}
                  </div>
                  <div className="text-xs text-muted">last seen {timeAgo(d.last_seen_at)}</div>
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
                    <Trash2 size={14} /> Revoke
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
      id="sync"
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

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
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
      toast("Master password changed", "success");
      onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Change master password"
      description="Re-encrypts the vault key. Synced devices use the new password after their next sign-in."
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!current || !next} onClick={() => void change()}>
            Change password
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void change();
        }}
      >
        <Field label="Current password">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} data-autofocus />
        </Field>
        <Field label="New password">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Confirm new password">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

function SecuritySection() {
  const { settings, update } = useSettings();
  const { vault, refreshVault } = useApp();
  const [changing, setChanging] = useState(false);

  return (
    <Section id="security" title="Security" description="The vault locks automatically and can be unlocked from the OS keychain.">
      <Row label="Auto-lock after inactivity">
        <Select className="w-[180px]" value={settings.autoLockMinutes} onChange={(e) => update({ autoLockMinutes: Number(e.target.value) })}>
          {[0, 5, 15, 30, 60, 240].map((m) => (
            <option key={m} value={m}>
              {m === 0 ? "Never" : `${m} minutes`}
            </option>
          ))}
        </Select>
      </Row>
      <Switch
        checked={!!vault?.keychainEnabled}
        onChange={(v) =>
          void api
            .vaultSetKeychain(v)
            .then(refreshVault)
            .catch((e) => toast(errorMessage(e), "error"))
        }
        label="Unlock with OS keychain"
        hint="Stores the vault key in the system keychain"
      />
      <Row label="Master password">
        <Button onClick={() => setChanging(true)}>
          <KeyRound size={16} /> Change password
        </Button>
      </Row>
      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
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
    <Section id="data" title="Import & export" description="Backups contain hosts, groups, snippets and known hosts — never passwords or keys.">
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
          <FileInput size={16} /> Import ~/.ssh/config
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
          <FileInput size={16} /> Import SSH config file…
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
          <FileInput size={16} /> Import backup (JSON/CSV)…
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
          <FileOutput size={16} /> Export JSON
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
          <FileOutput size={16} /> Export hosts CSV
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
          <FileOutput size={16} /> Export as SSH config
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

  const status = info?.available ? `${info.latest} available` : info ? "latest" : null;
  return (
    <Section id="updates" title="Updates" description={version ? `Termindo ${version}${status ? ` · ${status}` : ""}` : undefined}>
      <Row label="Check for updates automatically" hint="Looks at GitHub Releases every few hours">
        <Button onClick={() => void check()} loading={busy}>
          {!busy && <RefreshCw size={16} />} Check now
        </Button>
        <Switch checked={enabled} onChange={(v) => update({ checkUpdates: v })} />
      </Row>
      {info?.available && (
        <div className="flex items-center gap-3 rounded-lg bg-accent/12 px-3.5 py-2.5 text-[13px] text-fg">
          <span className="flex-1">
            Version <b>{info.latest}</b> is available.
          </span>
          <Button variant="primary" size="sm" onClick={() => openRelease(info)}>
            <Download size={16} /> Download
          </Button>
        </div>
      )}
      {error && <span className="text-xs text-danger">Could not check: {error}</span>}
    </Section>
  );
}

const SECTIONS = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "security", label: "Security", icon: Shield },
  { id: "sync", label: "Sync account", icon: Cloud },
  { id: "data", label: "Import & export", icon: ArrowLeftRight },
  { id: "updates", label: "Updates", icon: Download },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
] as const;

export function SettingsView() {
  const { settings, update } = useSettings();
  const [active, setActive] = useState<string>("appearance");

  // Highlight the section nearest the top of the scroll area.
  useEffect(() => {
    const root = document.getElementById("settings-appearance")?.closest("main");
    if (!root) return;
    const onScroll = () => {
      const top = root.getBoundingClientRect().top;
      let current: string = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const el = document.getElementById(`settings-${s.id}`);
        if (el && el.getBoundingClientRect().top - top < 120) current = s.id;
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = SECTIONS[SECTIONS.length - 1].id;
      setActive(current);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="flex gap-8 px-8 pb-8 pt-4">
      <div className="sticky top-4 flex w-[200px] shrink-0 flex-col gap-4 self-start">
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-fg">Settings</h1>
        <nav className="flex flex-col gap-0.5">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setActive(s.id);
                document.getElementById(`settings-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors",
                active === s.id ? "bg-panel-2 font-semibold text-fg" : "font-medium text-fg-2 hover:text-fg",
              )}
            >
              <s.icon size={16} className={active === s.id ? "text-accent" : undefined} />
              {s.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex min-w-0 max-w-[820px] flex-1 flex-col gap-5">
        <Section id="appearance" title="Appearance">
          <Row label="App theme" hint="Follows your OS when set to System">
            <Segmented
              value={settings.appTheme}
              options={[
                ["dark", "Dark"],
                ["light", "Light"],
                ["system", "System"],
              ]}
              onChange={(v) => update({ appTheme: v })}
            />
          </Row>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-3">
            {TERMINAL_THEMES.map((t) => (
              <ThemePreview key={t.id} id={t.id} selected={settings.terminalTheme === t.id} onClick={() => update({ terminalTheme: t.id })} />
            ))}
          </div>
        </Section>

        <Section id="terminal" title="Terminal">
          <div className="grid grid-cols-[minmax(180px,2fr)_1fr_1fr_1.2fr_1.2fr] gap-3">
            <Field label="Font family">
              <Input
                className="font-mono"
                title="CSS font list; the first installed font is used."
                value={settings.fontFamily}
                onChange={(e) => update({ fontFamily: e.target.value || DEFAULT_SETTINGS.fontFamily })}
              />
            </Field>
            <Field label="Size">
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
            <Field label="Scrollback">
              <Input type="number" min={100} max={200000} step={1000} value={settings.scrollback} onChange={(e) => update({ scrollback: Number(e.target.value) || 10000 })} />
            </Field>
          </div>
          <Switch checked={settings.cursorBlink} onChange={(v) => update({ cursorBlink: v })} label="Blinking cursor" />
          <Switch checked={settings.copyOnSelect} onChange={(v) => update({ copyOnSelect: v })} label="Copy on select" hint="Selected text goes straight to the clipboard" />
          <Switch
            checked={settings.rightClickPaste}
            onChange={(v) => update({ rightClickPaste: v })}
            label="Right-click pastes"
            hint="Copies the selection if there is one, otherwise pastes"
          />
          <Switch checked={settings.confirmCloseTab} onChange={(v) => update({ confirmCloseTab: v })} label="Confirm before closing active sessions" />
          <Switch checked={settings.restoreSession} onChange={(v) => update({ restoreSession: v })} label="Restore tabs and splits on startup" />
        </Section>

        <SecuritySection />
        <AccountSection />
        <DataSection />
        <UpdatesSection />

        <Section id="shortcuts" title="Shortcuts">
          <div className="grid grid-cols-2 gap-x-8 gap-y-0.5">
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
              <div key={k} className="flex items-center justify-between border-b border-line py-2 text-[13px]">
                <span className="text-fg-2">{v}</span>
                <Kbd>{isMac ? k.replace(/Ctrl/g, "⌘") : k}</Kbd>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

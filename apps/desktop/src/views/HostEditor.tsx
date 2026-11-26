import { useEffect, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { hostColor, PALETTE, useData } from "../stores/data";
import { Check, FileKey, KeyRound, MessageSquare, Server, SlidersHorizontal, UserRound, X } from "lucide-react";
import { toast } from "../stores/ui";
import type { AuthType, Group, Host } from "../lib/types";
import { Button, Caption, Dialog, Field, Input, Select, Switch, Textarea } from "../components/ui";
import { cn } from "../lib/utils";

const AUTH_TYPES: { id: AuthType; label: string; icon: typeof KeyRound }[] = [
  { id: "password", label: "Password", icon: KeyRound },
  { id: "key", label: "Private key", icon: FileKey },
  { id: "agent", label: "SSH agent", icon: UserRound },
  { id: "interactive", label: "Interactive", icon: MessageSquare },
];


export function groupPath(groups: Group[], id: string | null): string {
  const parts: string[] = [];
  let cur = groups.find((g) => g.id === id);
  let guard = 0;
  while (cur && guard++ < 20) {
    parts.unshift(cur.name);
    cur = groups.find((g) => g.id === cur!.parentId);
  }
  return parts.join(" / ");
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <Caption>{title}</Caption>
      {children}
    </div>
  );
}

/** Chip input: Enter / comma adds a tag, Backspace on empty input removes the last one. */
function TagInput({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const parts = draft
      .split(",")
      .map((t) => t.trim().replace(/^#/, ""))
      .filter((t) => t && !tags.includes(t));
    if (parts.length) onChange([...tags, ...parts]);
    setDraft("");
  };
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-transparent bg-panel-2 px-2 py-[5px] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
      {tags.map((t) => (
        <span key={t} className="inline-flex h-[26px] items-center gap-1.5 rounded-md bg-panel-3 pl-2 pr-1.5 text-xs font-medium text-fg">
          #{t}
          <button type="button" className="text-muted hover:text-fg" onClick={() => onChange(tags.filter((x) => x !== t))} title={`Remove ${t}`}>
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => (e.target.value.endsWith(",") ? (setDraft(e.target.value), setTimeout(commit)) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft && tags.length) onChange(tags.slice(0, -1));
        }}
        onBlur={commit}
        spellCheck={false}
        placeholder="Add tag…"
        className="h-[26px] min-w-[80px] flex-1 bg-transparent px-1 text-[13px] text-fg outline-none placeholder:text-muted"
      />
    </div>
  );
}

function ColorPicker({ value, onChange }: { value: string | null; onChange: (c: string | null) => void }) {
  return (
    <div className="flex h-10 items-center gap-2">
      {PALETTE.map((c) => {
        const selected = value?.toLowerCase() === c;
        return (
          <button
            type="button"
            key={c}
            title={selected ? "Clear color" : c}
            onClick={() => onChange(selected ? null : c)}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-lg text-[#0b0f17] transition-shadow",
              selected && "ring-2 ring-fg ring-offset-2 ring-offset-panel",
            )}
            style={{ background: c }}
          >
            {selected && <Check size={14} strokeWidth={3} />}
          </button>
        );
      })}
    </div>
  );
}

export function HostEditor({ host, onClose }: { host: Host | null; onClose: () => void }) {
  const { groups, hosts, credentials, snippets, loadHosts, loadCredentials } = useData();
  const [h, setH] = useState<Host | null>(host);
  const [password, setPassword] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    setH(host);
    setPassword("");
    setTags(host?.tags ?? []);
    setAdvanced(false);
  }, [host]);

  if (!h) return null;
  const set = (patch: Partial<Host>) => setH({ ...h, ...patch });
  const setOpt = (patch: Partial<Host["options"]>) => setH({ ...h, options: { ...h.options, ...patch } });
  const creds = credentials.filter((c) => (h.authType === "key" ? c.kind === "private_key" : c.kind === "password"));

  const save = async () => {
    if (!h.hostname.trim()) return toast("Hostname is required", "error");
    setSaving(true);
    try {
      let credentialId = h.authType === "password" || h.authType === "key" ? h.credentialId : null;
      if (h.authType === "password" && password) {
        const cred = await api.credentialSave({
          id: credentialId,
          label: `${h.label || h.hostname} password`,
          kind: "password",
          password,
        });
        credentialId = cred.id;
        void loadCredentials();
      }
      const port = Number(h.port) || 22;
      // Allow "user@host:port" in the hostname field.
      let { hostname, username } = h;
      const m = hostname.trim().match(/^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
      let finalPort = port;
      if (m) {
        if (m[1] && !username) username = m[1];
        hostname = m[2];
        if (m[3]) finalPort = Number(m[3]);
      }
      await api.hostSave({
        ...h,
        hostname,
        username,
        port: finalPort,
        credentialId,
        tags,
      });
      await loadHosts();
      toast(h.id ? "Host updated" : "Host added", "success");
      onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const jumpHost = (
    <Field label="Jump host (ProxyJump)">
      <Select value={h.jumpHostId ?? ""} onChange={(e) => set({ jumpHostId: e.target.value || null })}>
        <option value="">Direct connection</option>
        {hosts
          .filter((o) => o.id !== h.id)
          .map((o) => (
            <option key={o.id} value={o.id}>
              {o.label || o.hostname}
            </option>
          ))}
      </Select>
    </Field>
  );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={h.id ? "Edit host" : "New host"}
      description="Tip: paste user@host:port into Hostname"
      icon={
        <div className="flex h-11 w-11 items-center justify-center rounded-[11px] text-[#0b0f17]" style={{ background: hostColor(groups, h) }}>
          <Server size={22} />
        </div>
      }
      width="max-w-[720px]"
      footer={
        <>
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className={cn("mr-auto flex items-center gap-2 text-[13px] hover:text-fg", advanced ? "text-accent" : "text-fg-2")}
          >
            <SlidersHorizontal size={16} /> Advanced · keepalive, startup snippet, notes
          </button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving}>
            {!saving && <Check size={16} />} Save host
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Section title="Connection">
          <div className="grid grid-cols-[1fr_220px] gap-3">
            <Field label="Label">
              <Input value={h.label} onChange={(e) => set({ label: e.target.value })} placeholder="My server" data-autofocus />
            </Field>
            <Field label="Group">
              <Select value={h.groupId ?? ""} onChange={(e) => set({ groupId: e.target.value || null })}>
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {groupPath(groups, g.id)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-[1fr_100px_200px] gap-3">
            <Field label="Hostname / IP">
              <Input className="font-mono" value={h.hostname} onChange={(e) => set({ hostname: e.target.value })} placeholder="example.com" />
            </Field>
            <Field label="Port">
              <Input className="font-mono" type="number" min={1} max={65535} value={h.port} onChange={(e) => set({ port: Number(e.target.value) })} />
            </Field>
            <Field label="Username">
              <Input className="font-mono" value={h.username} onChange={(e) => set({ username: e.target.value })} placeholder="root" />
            </Field>
          </div>
        </Section>

        <Section title="Authentication">
          <div className="grid grid-cols-4 gap-1 rounded-[10px] bg-panel-2 p-1">
            {AUTH_TYPES.map((a) => (
              <button
                type="button"
                key={a.id}
                onClick={() => set({ authType: a.id, credentialId: a.id === h.authType ? h.credentialId : null })}
                className={cn(
                  "flex h-8 items-center justify-center gap-2 rounded-[7px] text-[13px] transition-colors",
                  h.authType === a.id ? "bg-accent font-semibold text-accent-fg" : "font-medium text-fg-2 hover:text-fg",
                )}
              >
                <a.icon size={14} />
                {a.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {h.authType === "password" && (
              <>
                <Field label="Saved password">
                  <Select value={h.credentialId ?? ""} onChange={(e) => set({ credentialId: e.target.value || null })}>
                    <option value="">Ask when connecting</option>
                    {creds.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={h.credentialId ? "Change password" : "Or set a password"}>
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Stored encrypted in your vault" />
                </Field>
              </>
            )}
            {h.authType === "key" && (
              <Field label="Key" hint={creds.length === 0 ? "Add or generate a key in Keychain first." : undefined}>
                <Select value={h.credentialId ?? ""} onChange={(e) => set({ credentialId: e.target.value || null })}>
                  <option value="">Select a key</option>
                  {creds.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {(h.authType === "agent" || h.authType === "interactive") && (
              <p className="self-center text-[13px] text-muted">
                {h.authType === "agent"
                  ? "Uses keys loaded in your running ssh-agent (SSH_AUTH_SOCK, or Pageant / OpenSSH agent on Windows)."
                  : "The server's prompts (password, OTP, …) are shown when connecting."}
              </p>
            )}
            {jumpHost}
          </div>
        </Section>

        <Section title="Organize">
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field label="Tags">
              <TagInput tags={tags} onChange={setTags} />
            </Field>
            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-medium text-fg-2">Color</span>
              <ColorPicker value={h.options.color ?? null} onChange={(c) => setOpt({ color: c ?? undefined })} />
            </div>
          </div>
        </Section>

        {advanced && (
          <Section title="Advanced">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Keepalive (seconds, 0 = off)">
                <Input type="number" min={0} value={h.options.keepaliveSecs ?? 30} onChange={(e) => setOpt({ keepaliveSecs: Number(e.target.value) })} />
              </Field>
              <Field label="Terminal type">
                <Input value={h.options.termType ?? ""} onChange={(e) => setOpt({ termType: e.target.value || undefined })} placeholder="xterm-256color" />
              </Field>
              <Field label="Startup snippet">
                <Select value={h.options.startupSnippetId ?? ""} onChange={(e) => setOpt({ startupSnippetId: e.target.value || undefined })}>
                  <option value="">None</option>
                  {snippets.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="SFTP start directory">
                <Input value={h.options.sftpStartDir ?? ""} onChange={(e) => setOpt({ sftpStartDir: e.target.value || undefined })} placeholder="~ (home)" />
              </Field>
            </div>
            <Switch
              checked={!!h.options.autoReconnect}
              onChange={(v) => setOpt({ autoReconnect: v })}
              label="Reconnect automatically"
              hint="When the connection drops unexpectedly (not after typing exit)."
            />
            <Field label="Notes">
              <Textarea rows={2} value={h.notes} onChange={(e) => set({ notes: e.target.value })} />
            </Field>
          </Section>
        )}
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

export function GroupEditor({ group, onClose }: { group: Group | null; onClose: () => void }) {
  const { groups, loadGroups } = useData();
  const [g, setG] = useState<Group | null>(group);
  useEffect(() => setG(group), [group]);
  if (!g) return null;
  const save = async () => {
    try {
      await api.groupSave(g);
      await loadGroups();
      onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={g.id ? "Edit group" : "New group"}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name">
          <Input value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} data-autofocus />
        </Field>
        <Field label="Parent group">
          <Select value={g.parentId ?? ""} onChange={(e) => setG({ ...g, parentId: e.target.value || null })}>
            <option value="">— top level —</option>
            {groups
              .filter((o) => o.id !== g.id)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {groupPath(groups, o.id)}
                </option>
              ))}
          </Select>
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-fg-2">Color</span>
          <ColorPicker value={g.color} onChange={(c) => setG({ ...g, color: c })} />
        </div>
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

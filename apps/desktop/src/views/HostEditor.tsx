import { useEffect, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { useData } from "../stores/data";
import { toast } from "../stores/ui";
import type { AuthType, Group, Host } from "../lib/types";
import { Button, Dialog, Field, Input, Select, Switch, Textarea } from "../components/ui";
import { cn } from "../lib/utils";

const AUTH_TYPES: { id: AuthType; label: string }[] = [
  { id: "password", label: "Password" },
  { id: "key", label: "Private key" },
  { id: "agent", label: "SSH agent" },
  { id: "interactive", label: "Interactive" },
];

export const TAB_COLORS = ["", "#22d3ee", "#4ade80", "#facc15", "#fb923c", "#f87171", "#c084fc", "#60a5fa"];

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

export function HostEditor({ host, onClose }: { host: Host | null; onClose: () => void }) {
  const { groups, hosts, credentials, snippets, loadHosts, loadCredentials } = useData();
  const [h, setH] = useState<Host | null>(host);
  const [password, setPassword] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setH(host);
    setPassword("");
    setTags(host?.tags.join(", ") ?? "");
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
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
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

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={h.id ? `Edit ${h.label || h.hostname}` : "New host"}
      width="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-6 gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Label" className="col-span-6">
          <Input value={h.label} onChange={(e) => set({ label: e.target.value })} placeholder="My server" data-autofocus />
        </Field>
        <Field label="Hostname / IP" className="col-span-4" hint="You can also type user@host:port">
          <Input value={h.hostname} onChange={(e) => set({ hostname: e.target.value })} placeholder="example.com" />
        </Field>
        <Field label="Port" className="col-span-2">
          <Input type="number" min={1} max={65535} value={h.port} onChange={(e) => set({ port: Number(e.target.value) })} />
        </Field>
        <Field label="Username" className="col-span-3">
          <Input value={h.username} onChange={(e) => set({ username: e.target.value })} placeholder="root" />
        </Field>
        <Field label="Group" className="col-span-3">
          <Select value={h.groupId ?? ""} onChange={(e) => set({ groupId: e.target.value || null })}>
            <option value="">— none —</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {groupPath(groups, g.id)}
              </option>
            ))}
          </Select>
        </Field>

        <div className="col-span-6">
          <span className="text-xs font-medium text-muted">Authentication</span>
          <div className="mt-1 grid grid-cols-4 gap-1 rounded-lg border border-line bg-bg p-1">
            {AUTH_TYPES.map((a) => (
              <button
                type="button"
                key={a.id}
                onClick={() => set({ authType: a.id, credentialId: a.id === h.authType ? h.credentialId : null })}
                className={cn(
                  "rounded-md py-1.5 text-[12px]",
                  h.authType === a.id ? "bg-accent text-accent-fg" : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>

        {h.authType === "password" && (
          <>
            <Field label="Saved password" className="col-span-3">
              <Select value={h.credentialId ?? ""} onChange={(e) => set({ credentialId: e.target.value || null })}>
                <option value="">— ask when connecting —</option>
                {creds.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={h.credentialId ? "Change password" : "Or set a password"} className="col-span-3" hint="Stored encrypted in your vault">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </Field>
          </>
        )}
        {h.authType === "key" && (
          <Field label="Private key" className="col-span-6" hint={creds.length === 0 ? "Add or generate a key in Keychain first." : undefined}>
            <Select value={h.credentialId ?? ""} onChange={(e) => set({ credentialId: e.target.value || null })}>
              <option value="">— select a key —</option>
              {creds.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} {c.publicKey ? `(${c.publicKey.split(" ")[0]})` : ""}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {h.authType === "agent" && (
          <p className="col-span-6 text-xs text-muted">Uses keys loaded in your running ssh-agent (SSH_AUTH_SOCK, or Pageant / OpenSSH agent on Windows).</p>
        )}
        {h.authType === "interactive" && (
          <p className="col-span-6 text-xs text-muted">The server's prompts (password, OTP, …) will be shown when connecting.</p>
        )}

        <Field label="Jump host (ProxyJump)" className="col-span-3">
          <Select value={h.jumpHostId ?? ""} onChange={(e) => set({ jumpHostId: e.target.value || null })}>
            <option value="">— direct connection —</option>
            {hosts
              .filter((o) => o.id !== h.id)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label || o.hostname}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Tags" className="col-span-3" hint="Comma separated">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="prod, web" />
        </Field>

        <details className="col-span-6 rounded-lg border border-line px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-muted">Advanced</summary>
          <div className="mt-3 grid grid-cols-6 gap-3">
            <Field label="Keepalive (seconds, 0 = off)" className="col-span-3">
              <Input
                type="number"
                min={0}
                value={h.options.keepaliveSecs ?? 30}
                onChange={(e) => setOpt({ keepaliveSecs: Number(e.target.value) })}
              />
            </Field>
            <Field label="Terminal type" className="col-span-3">
              <Input value={h.options.termType ?? ""} onChange={(e) => setOpt({ termType: e.target.value || undefined })} placeholder="xterm-256color" />
            </Field>
            <Field label="Startup snippet" className="col-span-3">
              <Select value={h.options.startupSnippetId ?? ""} onChange={(e) => setOpt({ startupSnippetId: e.target.value || undefined })}>
                <option value="">— none —</option>
                {snippets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="SFTP start directory" className="col-span-3">
              <Input value={h.options.sftpStartDir ?? ""} onChange={(e) => setOpt({ sftpStartDir: e.target.value || undefined })} placeholder="~ (home)" />
            </Field>
            <div className="col-span-6">
              <span className="text-xs font-medium text-muted">Tab color</span>
              <div className="mt-1 flex gap-2">
                {TAB_COLORS.map((c) => (
                  <button
                    type="button"
                    key={c || "none"}
                    onClick={() => setOpt({ color: c || undefined })}
                    className={cn(
                      "h-6 w-6 rounded-full border-2",
                      (h.options.color ?? "") === c ? "border-fg" : "border-transparent",
                      !c && "bg-panel-2",
                    )}
                    style={c ? { background: c } : undefined}
                    title={c || "Default"}
                  />
                ))}
              </div>
            </div>
            <div className="col-span-6">
              <Switch
                checked={!!h.options.autoReconnect}
                onChange={(v) => setOpt({ autoReconnect: v })}
                label="Reconnect automatically"
                hint="When the connection drops unexpectedly (not after typing exit)."
              />
            </div>
          </div>
        </details>

        <Field label="Notes" className="col-span-6">
          <Textarea rows={2} value={h.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
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
          <Button onClick={onClose}>Cancel</Button>
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
        <div>
          <span className="text-xs font-medium text-muted">Color</span>
          <div className="mt-1 flex gap-2">
            {TAB_COLORS.map((c) => (
              <button
                type="button"
                key={c || "none"}
                onClick={() => setG({ ...g, color: c || null })}
                className={cn("h-6 w-6 rounded-full border-2", (g.color ?? "") === c ? "border-fg" : "border-transparent", !c && "bg-panel-2")}
                style={c ? { background: c } : undefined}
              />
            ))}
          </div>
        </div>
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

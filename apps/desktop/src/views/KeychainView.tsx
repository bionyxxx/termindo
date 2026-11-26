import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as DM from "@radix-ui/react-dropdown-menu";
import { Copy, Eye, FileKey, KeyRound, MoreHorizontal, Pencil, ShieldCheck, Sparkles, Trash2, Upload } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useData } from "../stores/data";
import { confirmDialog, promptInput, toast } from "../stores/ui";
import type { CredentialInfo, CredentialKind, KeyInspection } from "../lib/types";
import { Badge, Button, Caption, Dialog, Empty, Field, Input, PageHeader, Textarea } from "../components/ui";

const COLS = "grid grid-cols-[minmax(180px,1.5fr)_minmax(110px,0.8fr)_minmax(180px,1.8fr)_90px_90px_76px] items-center gap-4";
import { cn, timeAgo } from "../lib/utils";

function CredentialEditor({ cred, kind, onClose }: { cred: CredentialInfo | null; kind: CredentialKind; onClose: () => void }) {
  const loadCredentials = useData((s) => s.loadCredentials);
  const [label, setLabel] = useState(cred?.label ?? "");
  const [password, setPassword] = useState("");
  const [key, setKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [inspection, setInspection] = useState<KeyInspection | null>(null);
  const isKey = kind === "private_key";

  useEffect(() => {
    if (!isKey || !key.trim()) return setInspection(null);
    const t = setTimeout(() => void api.keyInspect(key, passphrase || undefined).then(setInspection), 250);
    return () => clearTimeout(t);
  }, [key, passphrase, isKey]);

  const save = async () => {
    try {
      await api.credentialSave({
        id: cred?.id ?? null,
        label,
        kind,
        password: !isKey && password ? password : null,
        privateKey: isKey && key ? key : null,
        passphrase: isKey ? passphrase : null,
      });
      await loadCredentials();
      onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const loadFile = async () => {
    const path = await open({ multiple: false, directory: false, title: "Select private key" });
    if (typeof path !== "string") return;
    try {
      // The backend reads the file and stores the key in the vault directly.
      const info = await api.credentialImportKeyFile(path, label || undefined, passphrase || undefined);
      await loadCredentials();
      toast(`Imported ${info.label}`, "success");
      onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={cred ? `Edit ${cred.label}` : isKey ? "Add private key" : "Add password"}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={!!(isKey && key && inspection?.error)}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Label">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} data-autofocus placeholder={isKey ? "work laptop key" : "prod root password"} />
        </Field>
        {isKey ? (
          <>
            <Field label={cred ? "Replace private key (leave empty to keep)" : "Private key"} hint="OpenSSH, PEM (RSA/ECDSA/Ed25519) or PuTTY PPK.">
              <Textarea rows={7} className="font-mono text-[11px]" value={key} onChange={(e) => setKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
            </Field>
            {!cred && (
              <Button onClick={() => void loadFile()} className="self-start">
                <FileKey size={16} /> Import from file…
              </Button>
            )}
            <Field label="Passphrase (if the key is encrypted)" hint="Stored encrypted in your vault so you aren't asked on every connection.">
              <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </Field>
            {inspection && (
              <div className={cn("rounded-lg px-3 py-2 font-mono text-xs", inspection.error ? "bg-danger/12 text-danger" : "bg-ok/12 text-ok")}>
                {inspection.error ?? `${inspection.info?.algorithm} · ${inspection.info?.fingerprint}`}
              </div>
            )}
          </>
        ) : (
          <Field label={cred ? "New password (leave empty to keep)" : "Password"}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

export function KeychainView() {
  const { credentials, hosts, loadCredentials } = useData();
  const [editing, setEditing] = useState<{ cred: CredentialInfo | null; kind: CredentialKind } | null>(null);

  const generate = async () => {
    const label = await promptInput({ title: "Generate Ed25519 key", label: "Label", defaultValue: "termindo", confirmLabel: "Generate" });
    if (!label) return;
    try {
      const c = await api.credentialGenerateKey(label);
      await loadCredentials();
      if (c.publicKey) {
        await writeText(c.publicKey);
        toast("Key generated. Public key copied: add it to ~/.ssh/authorized_keys on your servers.", "success");
      }
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const del = async (c: CredentialInfo) => {
    const used = hosts.filter((h) => h.credentialId === c.id).length;
    if (
      !(await confirmDialog({
        title: `Delete ${c.label}?`,
        message: used ? `${used} host(s) use it and will need new credentials.` : "This cannot be undone.",
        danger: true,
        confirmLabel: "Delete",
      }))
    )
      return;
    await api.credentialDelete(c.id);
    await loadCredentials();
  };

  const reveal = async (c: CredentialInfo) => {
    try {
      const s = await api.credentialReveal(c.id);
      const value = c.kind === "password" ? s.password : s.privateKey;
      if (value) {
        await writeText(value);
        toast(`${c.kind === "password" ? "Password" : "Private key"} copied to clipboard`, "success");
      }
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const keyType = (c: CredentialInfo) => {
    if (c.kind === "password") return "Password";
    const algo = c.publicKey?.split(" ")[0] ?? "";
    return algo.replace(/^ssh-/, "").replace(/^ecdsa-sha2-/, "ecdsa-").toUpperCase() || "Private key";
  };
  const shortKey = (k: string) => {
    const [algo, body] = k.split(" ");
    if (!body) return k;
    return `${algo} ${body.length > 24 ? `${body.slice(0, 16)}…${body.slice(-4)}` : body}`;
  };
  const MENU_ITEM =
    "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-fg-2 outline-none data-[highlighted]:bg-panel-3 data-[highlighted]:text-fg";

  return (
    <div className="px-8 pb-8 pt-4">
      <PageHeader
        title="Keychain"
        subtitle="Passwords and SSH keys, encrypted with your vault key"
        actions={
          <>
            <Button onClick={() => setEditing({ cred: null, kind: "password" })}>
              <KeyRound size={16} /> Add password
            </Button>
            <Button onClick={() => setEditing({ cred: null, kind: "private_key" })}>
              <Upload size={16} /> Import key
            </Button>
            <Button variant="primary" onClick={() => void generate()}>
              <Sparkles size={16} /> Generate key
            </Button>
          </>
        }
      />
      <div className="mb-6 flex items-center gap-2.5 rounded-[10px] bg-accent/12 px-4 py-3 text-[13px] text-fg">
        <ShieldCheck size={16} className="shrink-0 text-accent" />
        Secrets never leave this device unencrypted — XChaCha20-Poly1305, synced end-to-end.
      </div>
      {credentials.length === 0 ? (
        <Empty icon={<KeyRound size={22} />} title="No credentials yet">
          Generate an Ed25519 key or add existing passwords and keys.
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl bg-panel">
          <div className={`${COLS} bg-panel-2/60 px-5 py-3`}>
            <Caption>Label</Caption>
            <Caption>Type</Caption>
            <Caption>Public key</Caption>
            <Caption>Used by</Caption>
            <Caption>Updated</Caption>
            <span />
          </div>
          {credentials.map((c) => {
            const used = hosts.filter((h) => h.credentialId === c.id).length;
            const Icon = c.kind === "password" ? KeyRound : FileKey;
            return (
              <div key={c.id} className={`${COLS} border-t border-line px-5 py-3`}>
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-panel-3 text-fg-2">
                    <Icon size={14} />
                  </span>
                  <span className="truncate text-sm font-semibold text-fg">{c.label}</span>
                </div>
                <div>
                  <Badge>{keyType(c)}</Badge>
                </div>
                <span className="selectable truncate font-mono text-xs text-fg-2" title={c.publicKey ?? undefined}>
                  {c.publicKey ? shortKey(c.publicKey) : "••••••••••••"}
                </span>
                <span className="text-[13px] text-fg-2">
                  {used} host{used === 1 ? "" : "s"}
                </span>
                <span className="text-[13px] text-fg-2">{timeAgo(c.updatedAt)}</span>
                <div className="flex justify-end gap-1.5">
                  <Button
                    size="icon"
                    variant="ghost"
                    title={c.publicKey ? "Copy public key" : "Copy password"}
                    onClick={() =>
                      c.publicKey ? void writeText(c.publicKey).then(() => toast("Public key copied", "success")) : void reveal(c)
                    }
                  >
                    <Copy size={16} />
                  </Button>
                  <DM.Root>
                    <DM.Trigger asChild>
                      <Button size="icon" variant="ghost" title="More">
                        <MoreHorizontal size={16} />
                      </Button>
                    </DM.Trigger>
                    <DM.Portal>
                      <DM.Content align="end" sideOffset={4} className="z-50 min-w-[180px] rounded-lg border border-line bg-panel-2 p-1 shadow-xl">
                        <DM.Item className={MENU_ITEM} onSelect={() => void reveal(c)}>
                          <Eye size={14} /> Copy {c.kind === "password" ? "password" : "private key"}
                        </DM.Item>
                        <DM.Item className={MENU_ITEM} onSelect={() => setEditing({ cred: c, kind: c.kind })}>
                          <Pencil size={14} /> Edit
                        </DM.Item>
                        <DM.Separator className="my-1 h-px bg-line" />
                        <DM.Item className={cn(MENU_ITEM, "text-danger data-[highlighted]:text-danger")} onSelect={() => void del(c)}>
                          <Trash2 size={14} /> Delete
                        </DM.Item>
                      </DM.Content>
                    </DM.Portal>
                  </DM.Root>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {editing && <CredentialEditor cred={editing.cred} kind={editing.kind} onClose={() => setEditing(null)} />}
    </div>
  );
}

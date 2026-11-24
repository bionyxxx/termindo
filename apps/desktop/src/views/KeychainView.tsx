import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, Eye, FileKey, KeyRound, Lock, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useData } from "../stores/data";
import { confirmDialog, promptInput, toast } from "../stores/ui";
import type { CredentialInfo, CredentialKind, KeyInspection } from "../lib/types";
import { Badge, Button, Dialog, Empty, Field, Input, SectionTitle, Textarea } from "../components/ui";
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
          <Button onClick={onClose}>Cancel</Button>
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
                <FileKey size={14} /> Import from file…
              </Button>
            )}
            <Field label="Passphrase (if the key is encrypted)" hint="Stored encrypted in your vault so you aren't asked on every connection.">
              <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </Field>
            {inspection && (
              <div className={cn("rounded-md border p-2 font-mono text-[11px]", inspection.error ? "border-danger/40 text-danger" : "border-ok/40 text-muted")}>
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

  return (
    <div className="p-5">
      <SectionTitle
        actions={
          <>
            <Button onClick={() => setEditing({ cred: null, kind: "password" })}>
              <Lock size={14} /> Add password
            </Button>
            <Button onClick={() => setEditing({ cred: null, kind: "private_key" })}>
              <Plus size={14} /> Add key
            </Button>
            <Button variant="primary" onClick={() => void generate()}>
              <Sparkles size={14} /> Generate key
            </Button>
          </>
        }
      >
        Keychain
      </SectionTitle>
      <p className="mb-4 text-xs text-muted">Secrets are encrypted with your vault key (XChaCha20-Poly1305) and are never synced in plaintext.</p>
      {credentials.length === 0 ? (
        <Empty icon={<KeyRound size={36} />} title="No credentials yet">
          Generate an Ed25519 key or add existing passwords and keys.
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-[12.5px]">
            <thead className="bg-panel text-left text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2">Label</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Public key</th>
                <th className="px-3 py-2">Used by</th>
                <th className="px-3 py-2">Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {credentials.map((c) => (
                <tr key={c.id} className="group border-t border-line bg-bg hover:bg-panel">
                  <td className="px-3 py-2 font-medium">{c.label}</td>
                  <td className="px-3 py-2">
                    <Badge>{c.kind === "password" ? "password" : c.publicKey?.split(" ")[0] ?? "private key"}</Badge>
                  </td>
                  <td className="max-w-[280px] px-3 py-2">
                    {c.publicKey ? (
                      <button
                        className="flex max-w-full items-center gap-1 truncate font-mono text-[11px] text-muted hover:text-fg"
                        title="Copy public key"
                        onClick={() => void writeText(c.publicKey!).then(() => toast("Public key copied", "success"))}
                      >
                        <Copy size={12} className="shrink-0" />
                        <span className="truncate">{c.publicKey}</span>
                      </button>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted">{hosts.filter((h) => h.credentialId === c.id).length} host(s)</td>
                  <td className="px-3 py-2 text-muted">{timeAgo(c.updatedAt)}</td>
                  <td className="px-2 py-1 text-right">
                    <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100">
                      <Button size="icon" variant="ghost" title="Copy secret" onClick={() => void reveal(c)}>
                        <Eye size={14} />
                      </Button>
                      <Button size="icon" variant="ghost" title="Edit" onClick={() => setEditing({ cred: c, kind: c.kind })}>
                        <Pencil size={14} />
                      </Button>
                      <Button size="icon" variant="ghost" title="Delete" onClick={() => void del(c)}>
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <CredentialEditor cred={editing.cred} kind={editing.kind} onClose={() => setEditing(null)} />}
    </div>
  );
}

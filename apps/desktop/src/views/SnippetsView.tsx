import { useState } from "react";
import { Code2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { customPlaceholders } from "../lib/utils";
import { useData } from "../stores/data";
import { confirmDialog, toast, useUi } from "../stores/ui";
import type { Snippet } from "../lib/types";
import { Badge, Button, Dialog, Field, Input, PageHeader, Textarea } from "../components/ui";
import { RunDialog } from "../components/SnippetPalette";
import { isMac } from "../lib/utils";

function SnippetEditor({ snippet, onClose, onDelete }: { snippet: Snippet; onClose: () => void; onDelete: () => void }) {
  const loadSnippets = useData((s) => s.loadSnippets);
  const [s, setS] = useState(snippet);
  const [tags, setTags] = useState(snippet.tags.join(", "));
  const save = async () => {
    try {
      await api.snippetSave({ ...s, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) });
      await loadSnippets();
      onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const vars = customPlaceholders(s.body);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={s.id ? "Edit snippet" : "New snippet"}
      width="max-w-xl"
      icon={
        <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-accent/12 text-accent">
          <Code2 size={20} />
        </div>
      }
      footer={
        <>
          {s.id && (
            <Button variant="danger" className="mr-auto" onClick={onDelete}>
              <Trash2 size={16} /> Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <Input value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} data-autofocus placeholder="Disk usage" />
        </Field>
        <Field
          label="Command"
          hint={
            <>
              Placeholders: <code>{"{{host}}"}</code> <code>{"{{port}}"}</code> <code>{"{{user}}"}</code> <code>{"{{label}}"}</code> are filled from the
              session; any other <code>{"{{name}}"}</code> is asked when running. Multiple lines run one after another.
            </>
          }
        >
          <Textarea rows={6} className="font-mono" value={s.body} onChange={(e) => setS({ ...s, body: e.target.value })} placeholder="df -h && free -m" />
        </Field>
        {vars.length > 0 && (
          <div className="flex flex-wrap gap-1 text-xs text-muted">
            Will ask for:{" "}
            {vars.map((v) => (
              <Badge key={v}>{v}</Badge>
            ))}
          </div>
        )}
        <Field label="Tags" hint="Comma separated">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** Command body with `{{placeholders}}` highlighted. */
function Body({ body }: { body: string }) {
  const parts = body.split(/(\{\{\s*[A-Za-z0-9_.-]{1,64}\s*\}\})/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <span key={i} className="font-semibold text-accent">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}

const blank = (): Snippet => ({ id: "", name: "", body: "", hotkey: null, tags: [], updatedAt: 0, deletedAt: null });

export function SnippetsView() {
  const { snippets, loadSnippets } = useData();
  const setSnippetPaletteOpen = useUi((s) => s.setSnippetPaletteOpen);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [running, setRunning] = useState<Snippet | null>(null);
  const del = async (s: Snippet) => {
    if (!(await confirmDialog({ title: "Delete snippet?", message: s.name, danger: true, confirmLabel: "Delete" }))) return;
    try {
      await api.snippetDelete(s.id);
      await loadSnippets();
      setEditing(null);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const shortcut = isMac ? "⌘⇧S" : "Ctrl+Shift+S";
  return (
    <div className="px-8 pb-8 pt-4">
      <PageHeader
        title="Snippets"
        subtitle={<>Reusable commands with {"{{placeholders}}"} — run on one or many sessions</>}
        actions={
          <>
            <Button onClick={() => setSnippetPaletteOpen(true)}>
              <Play size={16} /> Run on sessions
            </Button>
            <Button variant="primary" onClick={() => setEditing(blank())}>
              <Plus size={16} /> New snippet
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-6">
        {snippets.map((s) => {
          const vars = customPlaceholders(s.body);
          return (
            <div key={s.id} className="flex flex-col gap-3.5 rounded-xl bg-panel p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
                  <Code2 size={16} />
                </div>
                <span className="flex-1 truncate text-base font-semibold text-fg">{s.name}</span>
                {s.tags.slice(0, 2).map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
                <Button size="icon" variant="ghost" title="Edit" onClick={() => setEditing(s)}>
                  <Pencil size={16} />
                </Button>
              </div>
              <pre className="selectable max-h-28 overflow-hidden whitespace-pre-wrap break-all rounded-lg bg-bg px-3 py-2.5 font-mono text-sm text-fg">
                <span className="text-muted">$ </span>
                <Body body={s.body} />
              </pre>
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate text-xs text-muted">
                  {vars.length === 0 ? "No placeholders" : `${vars.length} placeholder${vars.length === 1 ? "" : "s"} · ${vars.join(", ")}`}
                </span>
                <Button size="sm" onClick={() => setRunning(s)}>
                  <Play size={16} /> Run
                </Button>
              </div>
            </div>
          );
        })}
        <button
          onClick={() => setEditing(blank())}
          className="flex min-h-[165px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-panel/50 text-center transition-colors hover:border-accent/50 hover:bg-panel"
        >
          <span className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg bg-panel-3 text-fg-2">
            <Plus size={18} />
          </span>
          <span className="text-sm font-semibold text-fg-2">New snippet</span>
          <span className="text-xs text-muted">{shortcut} to run from anywhere</span>
        </button>
      </div>
      {editing && <SnippetEditor snippet={editing} onClose={() => setEditing(null)} onDelete={() => void del(editing)} />}
      {running && <RunDialog snippet={running} onClose={() => setRunning(null)} />}
    </div>
  );
}

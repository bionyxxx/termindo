import { useState } from "react";
import { Code2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { customPlaceholders } from "../lib/utils";
import { useData } from "../stores/data";
import { confirmDialog, toast, useUi } from "../stores/ui";
import type { Snippet } from "../lib/types";
import { Badge, Button, Dialog, Empty, Field, Input, SectionTitle, Textarea } from "../components/ui";

function SnippetEditor({ snippet, onClose }: { snippet: Snippet; onClose: () => void }) {
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
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
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

export function SnippetsView() {
  const { snippets, loadSnippets } = useData();
  const setSnippetPaletteOpen = useUi((s) => s.setSnippetPaletteOpen);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const del = async (s: Snippet) => {
    if (!(await confirmDialog({ title: "Delete snippet?", message: s.name, danger: true, confirmLabel: "Delete" }))) return;
    await api.snippetDelete(s.id);
    await loadSnippets();
  };
  return (
    <div className="p-5">
      <SectionTitle
        actions={
          <>
            <Button onClick={() => setSnippetPaletteOpen(true)}>
              <Play size={14} /> Run…
            </Button>
            <Button variant="primary" onClick={() => setEditing({ id: "", name: "", body: "", hotkey: null, tags: [], updatedAt: 0, deletedAt: null })}>
              <Plus size={14} /> New snippet
            </Button>
          </>
        }
      >
        Snippets
      </SectionTitle>
      {snippets.length === 0 ? (
        <Empty icon={<Code2 size={36} />} title="No snippets yet">
          Save commands you run often and send them to one or many sessions at once (Ctrl+Shift+S).
        </Empty>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
          {snippets.map((s) => (
            <div key={s.id} className="group flex flex-col gap-2 rounded-xl border border-line bg-panel p-3.5">
              <div className="flex items-center gap-2">
                <Code2 size={15} className="text-accent" />
                <span className="truncate font-medium">{s.name}</span>
                <div className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100">
                  <Button size="icon" variant="ghost" onClick={() => setEditing(s)}>
                    <Pencil size={14} />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => void del(s)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
              <pre className="selectable max-h-24 overflow-hidden whitespace-pre-wrap break-all rounded-md bg-bg p-2 font-mono text-[11.5px] text-muted">{s.body}</pre>
              {s.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {s.tags.map((t) => (
                    <Badge key={t}>#{t}</Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {editing && <SnippetEditor snippet={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

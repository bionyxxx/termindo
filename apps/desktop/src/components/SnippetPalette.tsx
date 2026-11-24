import { useEffect, useMemo, useState } from "react";
import * as RDialog from "@radix-ui/react-dialog";
import { Code2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { cn, customPlaceholders } from "../lib/utils";
import { useData } from "../stores/data";
import { toast, useUi } from "../stores/ui";
import { layoutPaneIds, useWorkspace } from "../stores/workspace";
import type { Snippet } from "../lib/types";
import { Button, Dialog, Field, Input, Switch } from "./ui";

type Scope = "pane" | "tab" | "all";

function RunDialog({ snippet, onClose }: { snippet: Snippet; onClose: () => void }) {
  const vars = customPlaceholders(snippet.body);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(vars.map((v) => [v, ""])));
  const [scope, setScope] = useState<Scope>("pane");
  const [execute, setExecute] = useState(true);
  const { tabs, activeTabId, panes } = useWorkspace();

  const targets = useMemo(() => {
    const live = (ids: string[]) => ids.filter((id) => panes[id]?.status === "connected");
    const tab = tabs.find((t) => t.id === activeTabId);
    if (scope === "pane") return tab?.kind === "terminal" ? live([tab.activePaneId]) : [];
    if (scope === "tab") return tab?.kind === "terminal" ? live(layoutPaneIds(tab.layout)) : [];
    return live(Object.keys(panes));
  }, [scope, tabs, activeTabId, panes]);

  const run = async () => {
    try {
      const n = await api.snippetRun(snippet.body, targets, values, execute);
      toast(`Sent "${snippet.name}" to ${n} session${n === 1 ? "" : "s"}`, "success");
      onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Run "${snippet.name}"`}
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={targets.length === 0} onClick={() => void run()}>
            Run on {targets.length} session{targets.length === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-bg p-2 font-mono text-[11.5px] text-muted">{snippet.body}</pre>
        {vars.map((v, i) => (
          <Field key={v} label={v}>
            <Input value={values[v]} data-autofocus={i === 0 || undefined} onChange={(e) => setValues((s) => ({ ...s, [v]: e.target.value }))} />
          </Field>
        ))}
        <div className="grid grid-cols-3 gap-1 rounded-lg border border-line bg-bg p-1">
          {(["pane", "tab", "all"] as Scope[]).map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => setScope(s)}
              className={cn("rounded-md py-1.5 text-[12px]", scope === s ? "bg-accent text-accent-fg" : "text-muted hover:bg-hover")}
            >
              {s === "pane" ? "Active pane" : s === "tab" ? "All panes in tab" : "All sessions"}
            </button>
          ))}
        </div>
        <Switch checked={execute} onChange={setExecute} label="Press Enter after sending" />
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

export function SnippetPalette() {
  const { snippetPaletteOpen, setSnippetPaletteOpen } = useUi();
  const snippets = useData((s) => s.snippets);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [running, setRunning] = useState<Snippet | null>(null);

  useEffect(() => {
    if (snippetPaletteOpen) {
      setQ("");
      setSel(0);
    }
  }, [snippetPaletteOpen]);

  const list = snippets.filter((s) => {
    const query = q.toLowerCase();
    return !query || s.name.toLowerCase().includes(query) || s.body.toLowerCase().includes(query) || s.tags.some((t) => t.toLowerCase().includes(query));
  });
  const pick = (s: Snippet | undefined) => {
    if (!s) return;
    setSnippetPaletteOpen(false);
    setRunning(s);
  };

  return (
    <>
      <RDialog.Root open={snippetPaletteOpen} onOpenChange={setSnippetPaletteOpen}>
        <RDialog.Portal>
          <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <RDialog.Content className="fixed left-1/2 top-[14vh] z-50 w-[560px] max-w-[92vw] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-panel shadow-2xl outline-none">
            <RDialog.Title className="sr-only">Snippets</RDialog.Title>
            <RDialog.Description className="sr-only">Pick a snippet to run</RDialog.Description>
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") setSel((s) => Math.min(list.length - 1, s + 1));
                else if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
                else if (e.key === "Enter") pick(list[sel]);
              }}
              placeholder="Run snippet…"
              className="w-full border-b border-line bg-transparent px-4 py-3.5 text-[14px] outline-none placeholder:text-muted"
            />
            <div className="max-h-[50vh] overflow-y-auto p-1.5">
              {list.length === 0 && <div className="px-3 py-6 text-center text-xs text-muted">No snippets. Create some in the Snippets view.</div>}
              {list.map((s, i) => (
                <button
                  key={s.id}
                  onMouseMove={() => setSel(i)}
                  onClick={() => pick(s)}
                  className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left", i === sel && "bg-accent/15")}
                >
                  <Code2 size={15} className={i === sel ? "text-accent" : "text-muted"} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px]">{s.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted">{s.body.split("\n")[0]}</div>
                  </div>
                </button>
              ))}
            </div>
          </RDialog.Content>
        </RDialog.Portal>
      </RDialog.Root>
      {running && <RunDialog snippet={running} onClose={() => setRunning(null)} />}
    </>
  );
}

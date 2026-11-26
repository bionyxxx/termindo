import { ShieldCheck, Trash2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useData } from "../stores/data";
import { confirmDialog, toast } from "../stores/ui";
import { Button, Caption, Empty, PageHeader } from "../components/ui";
import { timeAgo } from "../lib/utils";

const COLS = "grid grid-cols-[minmax(180px,1.4fr)_minmax(140px,1fr)_minmax(160px,1.8fr)_100px_40px] items-center gap-4";

export function KnownHostsView() {
  const { knownHosts, loadKnownHosts } = useData();
  const del = async (id: string, name: string) => {
    if (!(await confirmDialog({ title: `Forget ${name}?`, message: "You'll be asked to verify its key again on the next connection.", confirmLabel: "Forget", danger: true })))
      return;
    try {
      await api.knownHostDelete(id);
      await loadKnownHosts();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    <div className="px-8 pb-8 pt-4">
      <PageHeader title="Known hosts" subtitle="Trusted on first use. A changed key blocks the connection until you confirm." />
      {knownHosts.length === 0 ? (
        <Empty icon={<ShieldCheck size={22} />} title="No known hosts yet">
          Server keys are recorded here the first time you trust them.
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl bg-panel">
          <div className={`${COLS} bg-panel-2/60 px-5 py-3`}>
            <Caption>Host</Caption>
            <Caption>Key type</Caption>
            <Caption>Fingerprint (SHA256)</Caption>
            <Caption>Trusted</Caption>
            <span />
          </div>
          {knownHosts.map((k) => {
            const name = `${k.host}${k.port !== 22 ? `:${k.port}` : ""}`;
            return (
              <div key={k.id} className={`${COLS} border-t border-line px-5 py-3`}>
                <div className="flex min-w-0 items-center gap-2.5">
                  <ShieldCheck size={16} className="shrink-0 text-ok" />
                  <span className="selectable truncate font-mono text-sm font-medium text-fg">{k.host}:{k.port}</span>
                </div>
                <div>
                  <span className="inline-flex h-[22px] items-center rounded-md bg-panel-3 px-2 font-mono text-xs text-fg-2">{k.keyType}</span>
                </div>
                <span className="selectable truncate font-mono text-xs text-fg-2" title={k.fingerprint}>
                  {k.fingerprint.replace(/^SHA256:/, "")}
                </span>
                <span className="text-[13px] text-fg-2">{timeAgo(k.updatedAt)}</span>
                <Button size="icon" variant="danger" title="Forget" onClick={() => void del(k.id, name)}>
                  <Trash2 size={16} />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

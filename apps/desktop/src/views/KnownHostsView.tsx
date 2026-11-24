import { ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useData } from "../stores/data";
import { confirmDialog } from "../stores/ui";
import { Button, Empty, SectionTitle } from "../components/ui";
import { timeAgo } from "../lib/utils";

export function KnownHostsView() {
  const { knownHosts, loadKnownHosts } = useData();
  const del = async (id: string, name: string) => {
    if (!(await confirmDialog({ title: `Forget ${name}?`, message: "You'll be asked to verify its key again on the next connection.", confirmLabel: "Forget" }))) return;
    await api.knownHostDelete(id);
    await loadKnownHosts();
  };
  return (
    <div className="p-5">
      <SectionTitle>Known hosts</SectionTitle>
      <p className="mb-4 text-xs text-muted">Server keys you trusted (trust on first use). A changed key triggers a warning before connecting.</p>
      {knownHosts.length === 0 ? (
        <Empty icon={<ShieldCheck size={36} />} title="No known hosts yet" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-[12.5px]">
            <thead className="bg-panel text-left text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2">Host</th>
                <th className="px-3 py-2">Key type</th>
                <th className="px-3 py-2">Fingerprint</th>
                <th className="px-3 py-2">Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {knownHosts.map((k) => (
                <tr key={k.id} className="group border-t border-line bg-bg hover:bg-panel">
                  <td className="px-3 py-2 font-mono">
                    {k.host}
                    {k.port !== 22 && `:${k.port}`}
                  </td>
                  <td className="px-3 py-2 text-muted">{k.keyType}</td>
                  <td className="selectable px-3 py-2 font-mono text-[11px] text-muted">{k.fingerprint}</td>
                  <td className="px-3 py-2 text-muted">{timeAgo(k.updatedAt)}</td>
                  <td className="px-2 text-right">
                    <Button size="icon" variant="ghost" className="opacity-0 group-hover:opacity-100" onClick={() => void del(k.id, k.host)}>
                      <Trash2 size={14} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

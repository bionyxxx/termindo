import { useEffect, useState } from "react";
import { History, Terminal } from "lucide-react";
import { api } from "../lib/api";
import { connectHost } from "../lib/actions";
import { hostTitle, useData } from "../stores/data";
import type { ConnectionLog } from "../lib/types";
import { Button, Empty, SectionTitle } from "../components/ui";
import { formatDate } from "../lib/utils";

function duration(l: ConnectionLog): string {
  if (!l.endedAt) return l.success ? "open / unknown" : "-";
  const s = Math.round((l.endedAt - l.startedAt) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function HistoryView() {
  const { hosts, stats } = useData();
  const [logs, setLogs] = useState<ConnectionLog[]>([]);
  useEffect(() => void api.historyList(undefined, 300).then(setLogs), []);
  const top = Object.values(stats)
    .sort((a, b) => b.connections - a.connections)
    .slice(0, 5)
    .map((s) => ({ s, h: hosts.find((h) => h.id === s.hostId) }))
    .filter((x) => x.h);

  return (
    <div className="p-5">
      <SectionTitle>History</SectionTitle>
      {top.length > 0 && (
        <div className="mb-5 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
          {top.map(({ s, h }) => (
            <div key={s.hostId} className="flex items-center gap-3 rounded-xl border border-line bg-panel p-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{hostTitle(h!)}</div>
                <div className="text-[11px] text-muted">
                  {s.connections} connections · {s.failures} failed
                </div>
              </div>
              <Button size="icon" variant="primary" onClick={() => connectHost(h!)}>
                <Terminal size={14} />
              </Button>
            </div>
          ))}
        </div>
      )}
      {logs.length === 0 ? (
        <Empty icon={<History size={36} />} title="No connections yet" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-[12.5px]">
            <thead className="bg-panel text-left text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2">Host</th>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Result</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => {
                const h = hosts.find((x) => x.id === l.hostId);
                return (
                  <tr key={l.id} className="border-t border-line bg-bg">
                    <td className="px-3 py-2">{h ? hostTitle(h) : <span className="text-muted">deleted host</span>}</td>
                    <td className="px-3 py-2 text-muted">{formatDate(l.startedAt)}</td>
                    <td className="px-3 py-2 text-muted">{duration(l)}</td>
                    <td className="px-3 py-2">{l.success ? <span className="text-ok">connected</span> : <span className="text-danger" title={l.error ?? ""}>{l.error ?? "failed"}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

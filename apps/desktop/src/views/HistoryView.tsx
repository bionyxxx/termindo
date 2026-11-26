import { useEffect, useMemo, useState } from "react";
import { History, Server } from "lucide-react";
import { api } from "../lib/api";
import { connectHost } from "../lib/actions";
import { hostColor, hostTitle, useData } from "../stores/data";
import type { ConnectionLog } from "../lib/types";
import { Caption, Empty, PageHeader, StatusPill } from "../components/ui";

const DAY = 86_400_000;

function seconds(l: ConnectionLog): number | null {
  return l.endedAt ? Math.max(0, Math.round((l.endedAt - l.startedAt) / 1000)) : null;
}

function fmtDuration(s: number | null, open = false): string {
  if (s == null) return open ? "open" : "–";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function shortDuration(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

function fmtStarted(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= startOfToday) return `Today, ${time}`;
  if (ms >= startOfToday - DAY) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "ok" }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-panel px-[18px] py-4">
      <span className="text-xs text-muted">{label}</span>
      <span className={`truncate text-2xl font-bold ${tone === "ok" ? "text-ok" : "text-fg"}`}>{value}</span>
      <span className="truncate text-xs text-muted">{sub}</span>
    </div>
  );
}

const COLS = "grid grid-cols-[minmax(200px,2.2fr)_minmax(140px,1fr)_minmax(100px,0.7fr)_minmax(160px,1.2fr)] items-center gap-4";

export function HistoryView() {
  const { hosts, stats, groups } = useData();
  const [logs, setLogs] = useState<ConnectionLog[]>([]);
  useEffect(() => void api.historyList(undefined, 300).then(setLogs), []);

  const summary = useMemo(() => {
    const now = Date.now();
    const week = logs.filter((l) => l.startedAt >= now - 7 * DAY);
    const prev = logs.filter((l) => l.startedAt < now - 7 * DAY && l.startedAt >= now - 14 * DAY);
    const failed = week.filter((l) => !l.success).length;
    const rate = week.length ? Math.round(((week.length - failed) / week.length) * 100) : null;
    const top = Object.values(stats).sort((a, b) => b.connections - a.connections)[0];
    const topHost = top && hosts.find((h) => h.id === top.hostId);
    const durations = logs.map(seconds).filter((s): s is number => s != null);
    const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
    const diff = week.length - prev.length;
    return {
      sessions: String(week.length),
      sessionsSub: `${diff >= 0 ? "+" : ""}${diff} vs last week`,
      rate: rate == null ? "–" : `${rate}%`,
      rateSub: `${failed} failed`,
      top: topHost ? hostTitle(topHost) : "–",
      topSub: top ? `${top.connections} session${top.connections === 1 ? "" : "s"}` : "no sessions yet",
      avg: avg == null ? "–" : shortDuration(avg),
      avgSub: durations.length ? `longest ${shortDuration(Math.max(...durations))}` : "no finished sessions",
    };
  }, [logs, stats, hosts]);

  return (
    <div className="px-8 pb-8 pt-4">
      <PageHeader title="History" subtitle="Every connection attempt on this device" />
      <div className="mb-6 grid grid-cols-4 gap-4">
        <Stat label="Sessions · 7 days" value={summary.sessions} sub={summary.sessionsSub} />
        <Stat label="Success rate" value={summary.rate} sub={summary.rateSub} tone="ok" />
        <Stat label="Most used" value={summary.top} sub={summary.topSub} />
        <Stat label="Avg. duration" value={summary.avg} sub={summary.avgSub} />
      </div>
      {logs.length === 0 ? (
        <Empty icon={<History size={22} />} title="No connections yet" />
      ) : (
        <div className="overflow-hidden rounded-xl bg-panel">
          <div className={`${COLS} bg-panel-2/60 px-5 py-3`}>
            <Caption>Host</Caption>
            <Caption>Started</Caption>
            <Caption>Duration</Caption>
            <Caption>Result</Caption>
          </div>
          {logs.map((l) => {
            const h = hosts.find((x) => x.id === l.hostId);
            return (
              <div key={l.id} className={`${COLS} border-t border-line px-5 py-3.5`}>
                {h ? (
                  <button className="flex min-w-0 items-center gap-3 text-left" title="Connect again" onDoubleClick={() => connectHost(h)}>
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#0b0f17]" style={{ background: hostColor(groups, h) }}>
                      <Server size={13} />
                    </span>
                    <span className="truncate text-sm font-semibold text-fg">{hostTitle(h)}</span>
                  </button>
                ) : (
                  <span className="text-sm text-muted">deleted host</span>
                )}
                <span className="text-[13px] text-fg-2">{fmtStarted(l.startedAt)}</span>
                <span className="font-mono text-[13px] text-fg-2">{l.success ? fmtDuration(seconds(l), true) : "–"}</span>
                <div className="min-w-0">
                  {l.success ? (
                    <StatusPill tone="ok">Connected</StatusPill>
                  ) : (
                    <StatusPill tone="danger" className="max-w-full" >
                      <span className="truncate" title={l.error ?? ""}>
                        {l.error ?? "Failed"}
                      </span>
                    </StatusPill>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

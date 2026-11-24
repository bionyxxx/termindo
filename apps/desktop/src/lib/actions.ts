import { hostTitle } from "../stores/data";
import { useWorkspace } from "../stores/workspace";
import type { Host, QuickConnect } from "./types";

export function connectHost(host: Host) {
  useWorkspace.getState().openTerminal({ hostId: host.id }, hostTitle(host), host.options.color);
}

export function sftpHost(host: Host) {
  useWorkspace.getState().openSftp({ hostId: host.id }, hostTitle(host), host.options.color);
}

/** Parse `user@host:port` (user optional). */
export function parseQuick(input: string): QuickConnect | null {
  const m = input.trim().match(/^(?:ssh\s+)?(?:([^@\s]+)@)?([A-Za-z0-9._\-[\]:]+?)(?::(\d{1,5}))?$/);
  if (!m || !m[2]) return null;
  return { username: m[1] ?? "", hostname: m[2], port: m[3] ? Number(m[3]) : 22 };
}

export function quickConnect(input: string): boolean {
  const q = parseQuick(input);
  if (!q) return false;
  const title = `${q.username ? q.username + "@" : ""}${q.hostname}${q.port && q.port !== 22 ? ":" + q.port : ""}`;
  useWorkspace.getState().openTerminal({ quick: q }, title);
  return true;
}

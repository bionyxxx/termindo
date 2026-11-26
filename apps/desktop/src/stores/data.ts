import { create } from "zustand";
import { api } from "../lib/api";
import type { CredentialInfo, Group, Host, HostStats, KnownHost, Snippet } from "../lib/types";

interface DataStore {
  hosts: Host[];
  groups: Group[];
  credentials: CredentialInfo[];
  snippets: Snippet[];
  knownHosts: KnownHost[];
  stats: Record<string, HostStats>;
  loaded: boolean;
  loadAll: () => Promise<void>;
  loadHosts: () => Promise<void>;
  loadGroups: () => Promise<void>;
  loadCredentials: () => Promise<void>;
  loadSnippets: () => Promise<void>;
  loadKnownHosts: () => Promise<void>;
  loadStats: () => Promise<void>;
  clear: () => void;
}

export const useData = create<DataStore>((set) => ({
  hosts: [],
  groups: [],
  credentials: [],
  snippets: [],
  knownHosts: [],
  stats: {},
  loaded: false,
  loadAll: async () => {
    const [hosts, groups, credentials, snippets, knownHosts, stats] = await Promise.all([
      api.hostsList(),
      api.groupsList(),
      api.credentialsList(),
      api.snippetsList(),
      api.knownHostsList(),
      api.hostStats(),
    ]);
    set({
      hosts,
      groups,
      credentials,
      snippets,
      knownHosts,
      stats: Object.fromEntries(stats.map((s) => [s.hostId, s])),
      loaded: true,
    });
  },
  loadHosts: async () => set({ hosts: await api.hostsList() }),
  loadGroups: async () => set({ groups: await api.groupsList() }),
  loadCredentials: async () => set({ credentials: await api.credentialsList() }),
  loadSnippets: async () => set({ snippets: await api.snippetsList() }),
  loadKnownHosts: async () => set({ knownHosts: await api.knownHostsList() }),
  loadStats: async () => {
    const stats = await api.hostStats();
    set({ stats: Object.fromEntries(stats.map((s) => [s.hostId, s])) });
  },
  clear: () => set({ hosts: [], groups: [], credentials: [], snippets: [], knownHosts: [], stats: {}, loaded: false }),
}));

export function emptyHost(groupId: string | null = null): Host {
  return {
    id: "",
    groupId,
    label: "",
    hostname: "",
    port: 22,
    username: "",
    authType: "password",
    credentialId: null,
    jumpHostId: null,
    tags: [],
    options: {},
    notes: "",
    updatedAt: 0,
    deletedAt: null,
  };
}

export function hostTitle(h: Pick<Host, "label" | "hostname">): string {
  return h.label || h.hostname;
}

/** `id` plus every nested sub-group id. */
export function groupDescendants(groups: Group[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of groups) {
      if (g.parentId && out.has(g.parentId) && !out.has(g.id)) {
        out.add(g.id);
        changed = true;
      }
    }
  }
  return out;
}

/** Number of hosts in a group, including its sub-groups. */
export function groupHostCount(groups: Group[], hosts: Host[], id: string): number {
  const ids = groupDescendants(groups, id);
  return hosts.filter((h) => h.groupId && ids.has(h.groupId)).length;
}

/** Fallback colors for groups and hosts without an explicit color (Solid palette). */
export const PALETTE = ["#f87171", "#fbbf24", "#34d399", "#22d3ee", "#6366f1", "#e879f9"];

/** A group's color: its own, the nearest ancestor's, or a palette color picked by its top-level position. */
export function groupColor(groups: Group[], id: string | null): string | null {
  let cur = groups.find((g) => g.id === id);
  let top = cur;
  let guard = 0;
  while (cur && guard++ < 20) {
    if (cur.color) return cur.color;
    top = cur;
    cur = groups.find((g) => g.id === cur!.parentId);
  }
  if (!top) return null;
  const tops = groups.filter((g) => !g.parentId);
  return PALETTE[Math.max(0, tops.indexOf(top)) % PALETTE.length];
}

/** Avatar color of a host: explicit host color, then its group's color. */
export function hostColor(groups: Group[], host: Host): string {
  return host.options.color || groupColor(groups, host.groupId) || PALETTE[3];
}

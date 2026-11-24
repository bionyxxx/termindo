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

import { create } from "zustand";
import { api } from "../lib/api";
import type { AccountInfo, VaultStatus } from "../lib/types";
import { useData } from "./data";

export type Phase = "loading" | "setup" | "locked" | "unlocked";

interface AppStore {
  phase: Phase;
  vault: VaultStatus | null;
  /** Shown once after creating a vault. */
  recoveryKey: string | null;
  account: AccountInfo | null;
  refreshVault: () => Promise<void>;
  setRecoveryKey: (k: string | null) => void;
  refreshAccount: () => Promise<void>;
  onUnlocked: () => Promise<void>;
  lock: () => Promise<void>;
}

export const useApp = create<AppStore>((set, get) => ({
  phase: "loading",
  vault: null,
  recoveryKey: null,
  account: null,
  refreshVault: async () => {
    const vault = await api.vaultStatus();
    set({ vault, phase: !vault.initialized ? "setup" : vault.unlocked ? "unlocked" : "locked" });
  },
  setRecoveryKey: (recoveryKey) => set({ recoveryKey }),
  refreshAccount: async () => {
    try {
      set({ account: await api.accountInfo() });
    } catch {
      /* locked */
    }
  },
  onUnlocked: async () => {
    await get().refreshVault();
    await Promise.all([useData.getState().loadAll(), get().refreshAccount()]);
  },
  lock: async () => {
    await api.vaultLock();
    useData.getState().clear();
    await get().refreshVault();
  },
}));

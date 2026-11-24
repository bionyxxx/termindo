import { create } from "zustand";
import { api } from "../lib/api";
import type { TransferInfo } from "../lib/types";

interface TransfersStore {
  items: Record<string, TransferInfo>;
  upsert: (t: TransferInfo) => void;
  load: () => Promise<void>;
  clearFinished: () => Promise<void>;
}

export const useTransfers = create<TransfersStore>((set) => ({
  items: {},
  upsert: (t) => set((s) => ({ items: { ...s.items, [t.id]: t } })),
  load: async () => {
    const list = await api.transfersList();
    set({ items: Object.fromEntries(list.map((t) => [t.id, t])) });
  },
  clearFinished: async () => {
    await api.transfersClear();
    set((s) => ({
      items: Object.fromEntries(Object.entries(s.items).filter(([, t]) => t.state !== "done" && t.state !== "cancelled")),
    }));
  },
}));

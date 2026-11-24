import { create } from "zustand";
import { api } from "../lib/api";

export interface Settings {
  appTheme: "dark" | "light" | "system";
  terminalTheme: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  scrollback: number;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  confirmCloseTab: boolean;
  autoLockMinutes: number;
  restoreSession: boolean;
  defaultServerUrl: string;
  sftpShowHidden: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  appTheme: "dark",
  terminalTheme: "termindo-dark",
  fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 14,
  lineHeight: 1.15,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: false,
  rightClickPaste: true,
  confirmCloseTab: true,
  autoLockMinutes: 0,
  restoreSession: true,
  defaultServerUrl: import.meta.env.VITE_DEFAULT_SYNC_URL?.trim() || "http://localhost:8080",
  sftpShowHidden: false,
};

interface SettingsStore {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<Settings>) => void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    try {
      const raw = await api.settingGet("settings");
      const parsed = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
      // Comes from the build (VITE_DEFAULT_SYNC_URL); older builds persisted localhost here.
      delete parsed.defaultServerUrl;
      set({ settings: { ...DEFAULT_SETTINGS, ...parsed }, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  update: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    void api.settingSet("settings", JSON.stringify(settings));
  },
}));

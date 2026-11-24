import { create } from "zustand";
import { uid } from "../lib/utils";
import type { PromptEvent } from "../lib/types";

export type View = "hosts" | "snippets" | "keychain" | "knownHosts" | "history" | "settings";

export interface Toast {
  id: string;
  kind: "info" | "success" | "error";
  message: string;
}

/** A prompt asked by the UI itself (password / passphrase / text input). */
export interface InputPrompt {
  id: string;
  title: string;
  message?: string;
  label: string;
  secret?: boolean;
  defaultValue?: string;
  confirmLabel?: string;
  resolve: (value: string | null) => void;
}

export interface ConfirmPrompt {
  id: string;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

interface UiStore {
  view: View;
  setView: (v: View) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  snippetPaletteOpen: boolean;
  setSnippetPaletteOpen: (open: boolean) => void;
  toasts: Toast[];
  toast: (message: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: string) => void;
  backendPrompts: PromptEvent[];
  pushBackendPrompt: (p: PromptEvent) => void;
  popBackendPrompt: (id: string) => void;
  inputPrompts: InputPrompt[];
  confirmPrompts: ConfirmPrompt[];
  closeInput: (id: string) => void;
  closeConfirm: (id: string) => void;
}

export const useUi = create<UiStore>((set) => ({
  view: "hosts",
  setView: (view) => set({ view }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  snippetPaletteOpen: false,
  setSnippetPaletteOpen: (snippetPaletteOpen) => set({ snippetPaletteOpen }),
  toasts: [],
  toast: (message, kind = "info") => {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 7000 : 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  backendPrompts: [],
  pushBackendPrompt: (p) => set((s) => ({ backendPrompts: [...s.backendPrompts, p] })),
  popBackendPrompt: (id) => set((s) => ({ backendPrompts: s.backendPrompts.filter((p) => p.id !== id) })),
  inputPrompts: [],
  confirmPrompts: [],
  closeInput: (id) => set((s) => ({ inputPrompts: s.inputPrompts.filter((p) => p.id !== id) })),
  closeConfirm: (id) => set((s) => ({ confirmPrompts: s.confirmPrompts.filter((p) => p.id !== id) })),
}));

export const toast = (message: string, kind?: Toast["kind"]) => useUi.getState().toast(message, kind);

/** Ask the user for a value. Resolves to `null` when cancelled. */
export function promptInput(opts: Omit<InputPrompt, "id" | "resolve">): Promise<string | null> {
  return new Promise((resolve) => {
    const id = uid();
    useUi.setState((s) => ({ inputPrompts: [...s.inputPrompts, { ...opts, id, resolve }] }));
  });
}

export function confirmDialog(opts: Omit<ConfirmPrompt, "id" | "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    const id = uid();
    useUi.setState((s) => ({ confirmPrompts: [...s.confirmPrompts, { ...opts, id, resolve }] }));
  });
}

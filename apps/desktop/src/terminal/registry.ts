// xterm.js instances live outside React so they survive tab switches and split
// re-layouts: a pane component only attaches the terminal's DOM element.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, Channel, errorCode, errorMessage } from "../lib/api";
import { useData } from "../stores/data";
import { type Settings, useSettings } from "../stores/settings";
import { promptInput, toast } from "../stores/ui";
import { useWorkspace } from "../stores/workspace";
import { MAX_RECONNECTS, Reconnector, type Retry } from "./reconnect";
import { terminalTheme } from "./themes";

const DIM = "\x1b[90m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Returns true if the key event was an app shortcut (handled elsewhere). */
type ShortcutFilter = (e: KeyboardEvent) => boolean;
let shortcutFilter: ShortcutFilter = () => false;
export function setShortcutFilter(f: ShortcutFilter) {
  shortcutFilter = f;
}

export class TermSession {
  readonly paneId: string;
  readonly term: Terminal;
  readonly fitAddon = new FitAddon();
  readonly search = new SearchAddon();
  readonly el: HTMLDivElement;
  private webgl?: WebglAddon;
  private opened = false;
  private started = false;
  private connected = false;
  private connecting = false;
  private disposed = false;
  private readonly autoReconnect = new Reconnector(() => void this.connect());
  /** One-off password entered in a prompt; kept in memory only for reconnects. */
  private password: string | null = null;
  private resizeTimer?: ReturnType<typeof setTimeout>;

  constructor(paneId: string, settings: Settings) {
    this.paneId = paneId;
    this.el = document.createElement("div");
    this.el.className = "h-full w-full";
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      scrollback: settings.scrollback,
      theme: terminalTheme(settings.terminalTheme).colors,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: true,
    });
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.loadAddon(
      new WebLinksAddon((e, uri) => {
        if (e.ctrlKey || e.metaKey) void openUrl(uri);
      }),
    );

    this.term.onData((data) => this.input(data));
    this.term.onBinary((data) => this.input(data));
    this.term.onResize(({ cols, rows }) => {
      if (!this.connected) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => void api.sshResize(this.paneId, cols, rows).catch(() => {}), 60);
    });
    this.term.onSelectionChange(() => {
      if (useSettings.getState().settings.copyOnSelect && this.term.hasSelection()) {
        void writeText(this.term.getSelection());
      }
    });
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));

    this.el.addEventListener("contextmenu", (e) => {
      if (!useSettings.getState().settings.rightClickPaste) return;
      e.preventDefault();
      if (this.term.hasSelection()) {
        void writeText(this.term.getSelection());
        this.term.clearSelection();
      } else {
        void this.paste();
      }
    });
  }

  private onKey(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.code === "KeyC") {
      if (this.term.hasSelection()) void writeText(this.term.getSelection());
      return false;
    }
    if (mod && e.shiftKey && e.code === "KeyV") {
      // Without this the webview also runs its native paste, so the text lands twice.
      e.preventDefault();
      void this.paste();
      return false;
    }
    if (shortcutFilter(e)) return false;
    return true;
  }

  async paste() {
    try {
      const text = await readText();
      if (text) this.term.paste(text);
    } catch (e) {
      toast(`Clipboard: ${errorMessage(e)}`, "error");
    }
  }

  copySelection() {
    if (this.term.hasSelection()) void writeText(this.term.getSelection());
  }

  private input(data: string) {
    if (!this.connected) {
      if (!this.connecting && (data === "\r" || data.toLowerCase() === "r")) void this.reconnect(true);
      return;
    }
    const ws = useWorkspace.getState();
    const pane = ws.panes[this.paneId];
    const tab = pane && ws.tabs.find((t) => t.id === pane.tabId);
    if (tab && tab.kind === "terminal" && tab.broadcast) {
      for (const id of ws.paneIdsOfTab(tab.id)) {
        const s = sessions.get(id);
        if (s?.connected) void api.sshWrite(id, data).catch(() => {});
      }
    } else {
      void api.sshWrite(this.paneId, data).catch(() => {});
    }
  }

  attach(host: HTMLElement) {
    if (this.el.parentElement !== host) host.appendChild(this.el);
    if (!this.opened) {
      this.term.open(this.el);
      this.opened = true;
      try {
        this.webgl = new WebglAddon();
        this.webgl.onContextLoss(() => {
          this.webgl?.dispose();
          this.webgl = undefined;
        });
        this.term.loadAddon(this.webgl);
      } catch {
        // WebGL unavailable (some WebKitGTK setups): xterm falls back to the DOM renderer.
        this.webgl = undefined;
      }
    }
    this.fit();
    if (!this.started) {
      this.started = true;
      void this.connect();
    }
  }

  fit() {
    if (!this.opened || !this.el.isConnected || this.el.clientWidth === 0) return;
    try {
      this.fitAddon.fit();
    } catch {
      /* not visible yet */
    }
  }

  focus() {
    this.term.focus();
  }

  private status(status: "connecting" | "connected" | "closed" | "error", error?: string) {
    useWorkspace.getState().setPaneStatus(this.paneId, status, error);
  }

  private pane() {
    return useWorkspace.getState().panes[this.paneId];
  }

  async connect(): Promise<void> {
    const pane = this.pane();
    if (!pane || this.disposed || this.connecting) return;
    this.connecting = true;
    this.status("connecting");
    this.term.write(`${DIM}Connecting to ${pane.title}…${RESET}\r\n`);
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buf) => this.term.write(new Uint8Array(buf));
    try {
      this.fit();
      await api.sshConnect(this.paneId, { ...pane.target, password: this.password }, this.term.cols, this.term.rows, channel);
      // The pane was closed while connecting: don't leave the session running.
      if (this.disposed) return void api.sshClose(this.paneId).catch(() => {});
      this.connected = true;
      this.autoReconnect.stop();
      this.status("connected");
      void useData.getState().loadStats();
      this.fit();
      void api.sshResize(this.paneId, this.term.cols, this.term.rows).catch(() => {});
    } catch (e) {
      const code = errorCode(e);
      if (code === "password_required" || code === "passphrase_required" || (code === "auth_failed" && this.password !== null)) {
        const value = await promptInput({
          title: code === "passphrase_required" ? "Key passphrase" : "Password",
          message: code === "auth_failed" ? `Authentication failed for ${pane.title}. Try again.` : errorMessage(e),
          label: code === "passphrase_required" ? "Passphrase" : "Password",
          secret: true,
          confirmLabel: "Connect",
        });
        this.connecting = false;
        if (value !== null) {
          this.password = value;
          return await this.connect();
        }
        this.autoReconnect.stop();
        this.term.write(`${RED}Cancelled.${RESET} ${DIM}Press Enter to retry.${RESET}\r\n`);
        this.status("error", "cancelled");
        return;
      }
      this.status("error", errorMessage(e));
      this.term.write(`${RED}✖ ${errorMessage(e)}${RESET}\r\n`);
      const retry = this.autoReconnect.failed(code);
      if (retry) this.announceRetry(retry);
      else this.term.write(`${DIM}Press Enter to retry.${RESET}\r\n`);
    } finally {
      this.connecting = false;
    }
  }

  async reconnect(manual = false) {
    if (manual) this.autoReconnect.retryNow();
    await this.connect();
  }

  private announceRetry({ attempt, delayMs }: Retry) {
    this.term.write(
      `${DIM}Reconnecting in ${delayMs / 1000} s… (attempt ${attempt}/${MAX_RECONNECTS})${RESET}\r\n`,
    );
  }

  /** Backend reports the shell closed. */
  onClosed(userClosed: boolean, exitStatus: number | null) {
    this.connected = false;
    if (this.disposed || userClosed) return;
    const pane = this.pane();
    this.status("closed");
    this.term.write(
      `\r\n${DIM}[Connection closed${exitStatus != null ? ` (exit ${exitStatus})` : ""}]${RESET}\r\n`,
    );
    const host = pane?.target.hostId ? useData.getState().hosts.find((h) => h.id === pane.target.hostId) : undefined;
    const auto = host?.options.autoReconnect ?? false;
    // Exit status 0 means the user typed `exit`: don't reconnect automatically.
    const retry = auto && exitStatus !== 0 ? this.autoReconnect.dropped() : null;
    if (retry) this.announceRetry(retry);
    else this.term.write(`${DIM}Press Enter to reconnect.${RESET}\r\n`);
  }

  applySettings(s: Settings) {
    this.term.options.fontFamily = s.fontFamily;
    this.term.options.fontSize = s.fontSize;
    this.term.options.lineHeight = s.lineHeight;
    this.term.options.cursorStyle = s.cursorStyle;
    this.term.options.cursorBlink = s.cursorBlink;
    this.term.options.scrollback = s.scrollback;
    this.term.options.theme = terminalTheme(s.terminalTheme).colors;
    this.fit();
  }

  isConnected() {
    return this.connected;
  }

  dispose() {
    this.disposed = true;
    this.autoReconnect.stop();
    if (this.started) void api.sshClose(this.paneId).catch(() => {});
    this.webgl?.dispose();
    this.term.dispose();
    this.el.remove();
  }
}

const sessions = new Map<string, TermSession>();

export function getSession(paneId: string): TermSession {
  let s = sessions.get(paneId);
  if (!s) {
    s = new TermSession(paneId, useSettings.getState().settings);
    sessions.set(paneId, s);
  }
  return s;
}

export function findSession(paneId: string): TermSession | undefined {
  return sessions.get(paneId);
}

export function disposeSession(paneId: string) {
  sessions.get(paneId)?.dispose();
  sessions.delete(paneId);
}

export function allSessions(): TermSession[] {
  return [...sessions.values()];
}

// Keep sessions in sync with the workspace: dispose terminals whose pane disappeared.
useWorkspace.subscribe((state) => {
  for (const id of [...sessions.keys()]) if (!state.panes[id]) disposeSession(id);
});

// Apply settings changes live.
useSettings.subscribe((state, prev) => {
  if (state.settings !== prev.settings) for (const s of sessions.values()) s.applySettings(state.settings);
});

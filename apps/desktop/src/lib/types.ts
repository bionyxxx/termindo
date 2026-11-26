// Mirrors of the Rust types exchanged over Tauri IPC (camelCase).

export type AuthType = "password" | "key" | "agent" | "interactive";
export type CredentialKind = "password" | "private_key";

export interface Group {
  id: string;
  name: string;
  parentId: string | null;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface HostOptions {
  keepaliveSecs?: number;
  autoReconnect?: boolean;
  termType?: string;
  startupSnippetId?: string;
  env?: [string, string][];
  color?: string;
  sftpStartDir?: string;
  [key: string]: unknown;
}

export interface Host {
  id: string;
  groupId: string | null;
  label: string;
  hostname: string;
  port: number;
  username: string;
  authType: AuthType;
  credentialId: string | null;
  jumpHostId: string | null;
  tags: string[];
  options: HostOptions;
  notes: string;
  updatedAt: number;
  deletedAt: number | null;
}

export interface CredentialInfo {
  id: string;
  label: string;
  kind: CredentialKind;
  publicKey: string | null;
  updatedAt: number;
}

export interface CredentialInput {
  id?: string | null;
  label: string;
  kind: CredentialKind;
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
}

export interface CredentialSecret {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface KeyInfo {
  algorithm: string;
  publicKey: string;
  fingerprint: string;
  encrypted: boolean;
}

export interface KeyInspection {
  encrypted: boolean;
  info: KeyInfo | null;
  error: string | null;
}

export interface Snippet {
  id: string;
  name: string;
  body: string;
  hotkey: string | null;
  tags: string[];
  updatedAt: number;
  deletedAt: number | null;
}

export interface KnownHost {
  id: string;
  host: string;
  port: number;
  keyType: string;
  key: string;
  fingerprint: string;
  updatedAt: number;
  deletedAt: number | null;
}

export interface ConnectionLog {
  id: number;
  hostId: string;
  startedAt: number;
  endedAt: number | null;
  success: boolean;
  error: string | null;
}

export interface HostStats {
  hostId: string;
  connections: number;
  failures: number;
  lastConnectedAt: number | null;
}

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  keychainEnabled: boolean;
}

export interface QuickConnect {
  hostname: string;
  port?: number;
  username: string;
}

export interface ConnectTarget {
  hostId?: string | null;
  quick?: QuickConnect | null;
  password?: string | null;
}

export interface ConnectInfo {
  sessionId: string;
  target: string;
}

export interface RemoteEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  permissions: number | null;
  mtime: number | null;
  owner: string | null;
  group: string | null;
}

export interface LocalEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number | null;
}

export interface SftpOpened {
  home: string;
  startDir: string;
  target: string;
}

export type TransferState = "queued" | "running" | "paused" | "done" | "error" | "cancelled";

export interface TransferInfo {
  id: string;
  sftpId: string;
  direction: "upload" | "download";
  localPath: string;
  remotePath: string;
  name: string;
  size: number;
  transferred: number;
  state: TransferState;
  error: string | null;
  priority: number;
  createdAt: number;
  speed: number;
}

export interface SyncReport {
  pushed: number;
  rejected: number;
  pulled: number;
  applied: number;
  skipped: number;
  finishedAt: number;
}

export interface SyncStatus {
  syncing: boolean;
  lastError: string | null;
  lastReport: SyncReport | null;
}

export interface AccountInfo {
  signedIn: boolean;
  serverUrl: string | null;
  email: string | null;
  deviceId: string | null;
  lastSyncedAt: number | null;
  status: SyncStatus;
}

export interface Device {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number;
  current: boolean;
}

export interface ImportSummary {
  groups: number;
  hosts: number;
  snippets: number;
  knownHosts: number;
}

export interface SshConfigImport {
  hosts: number;
  skipped: number;
  keys: number;
  warnings: string[];
}

export interface HostKeyInfo {
  host: string;
  port: number;
  keyType: string;
  key: string;
  fingerprint: string;
}

export interface KbdRequest {
  host: string;
  name: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
}

export type PromptEvent =
  | {
      id: string;
      kind: "hostKey";
      label: string;
      status: "unknown" | "changed";
      info: HostKeyInfo;
      previousFingerprint: string | null;
      previousKeyType: string | null;
    }
  | { id: string; kind: "keyboardInteractive"; label: string; request: KbdRequest };

/** `auto`: installed in-app by the updater plugin. `manual`: Linux .deb/.rpm, download from the release page. */
export type UpdateMode = "auto" | "manual";

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  url: string;
  notes: string | null;
}

export interface CmdError {
  code: string;
  message: string;
}

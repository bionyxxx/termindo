// Typed wrappers around the Tauri commands defined in src-tauri/src/commands.
import { Channel, invoke } from "@tauri-apps/api/core";
import type * as T from "./types";

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

export function errorCode(e: unknown): string | undefined {
  if (e && typeof e === "object" && "code" in e) return String((e as { code: unknown }).code);
  return undefined;
}

export const api = {
  // vault
  vaultStatus: () => invoke<T.VaultStatus>("vault_status"),
  vaultCreate: (password: string) => invoke<{ recoveryKey: string }>("vault_create", { password }),
  vaultUnlock: (password: string) => invoke<void>("vault_unlock", { password }),
  vaultUnlockKeychain: () => invoke<boolean>("vault_unlock_keychain"),
  vaultSetKeychain: (enabled: boolean) => invoke<void>("vault_set_keychain", { enabled }),
  vaultLock: () => invoke<void>("vault_lock"),
  vaultChangePassword: (current: string, newPassword: string) =>
    invoke<void>("vault_change_password", { current, newPassword }),
  vaultRecover: (recoveryKey: string, newPassword: string) =>
    invoke<void>("vault_recover", { recoveryKey, newPassword }),

  // groups & hosts
  groupsList: () => invoke<T.Group[]>("groups_list"),
  groupSave: (group: T.Group) => invoke<T.Group>("group_save", { group }),
  groupDelete: (id: string) => invoke<void>("group_delete", { id }),
  hostsList: () => invoke<T.Host[]>("hosts_list"),
  hostSave: (host: T.Host) => invoke<T.Host>("host_save", { host }),
  hostDelete: (id: string) => invoke<void>("host_delete", { id }),
  hostDuplicate: (id: string) => invoke<T.Host>("host_duplicate", { id }),
  hostStats: () => invoke<T.HostStats[]>("host_stats"),
  historyList: (hostId?: string, limit?: number) => invoke<T.ConnectionLog[]>("history_list", { hostId, limit }),

  // credentials
  credentialsList: () => invoke<T.CredentialInfo[]>("credentials_list"),
  credentialSave: (input: T.CredentialInput) => invoke<T.CredentialInfo>("credential_save", { input }),
  credentialDelete: (id: string) => invoke<void>("credential_delete", { id }),
  credentialReveal: (id: string) => invoke<T.CredentialSecret>("credential_reveal", { id }),
  credentialGenerateKey: (label: string) => invoke<T.CredentialInfo>("credential_generate_key", { label }),
  credentialImportKeyFile: (path: string, label?: string, passphrase?: string) =>
    invoke<T.CredentialInfo>("credential_import_key_file", { path, label, passphrase }),
  keyInspect: (privateKey: string, passphrase?: string) =>
    invoke<T.KeyInspection>("key_inspect", { privateKey, passphrase }),

  // snippets
  snippetsList: () => invoke<T.Snippet[]>("snippets_list"),
  snippetSave: (snippet: T.Snippet) => invoke<T.Snippet>("snippet_save", { snippet }),
  snippetDelete: (id: string) => invoke<void>("snippet_delete", { id }),
  snippetPlaceholders: (body: string) => invoke<string[]>("snippet_placeholders", { body }),
  snippetRun: (body: string, sessionIds: string[], vars: Record<string, string>, execute: boolean) =>
    invoke<number>("snippet_run", { body, sessionIds, vars, execute }),

  // known hosts
  knownHostsList: () => invoke<T.KnownHost[]>("known_hosts_list"),
  knownHostDelete: (id: string) => invoke<void>("known_host_delete", { id }),

  // settings
  settingGet: (key: string) => invoke<string | null>("setting_get", { key }),
  settingSet: (key: string, value: string) => invoke<void>("setting_set", { key, value }),

  // import / export
  importSshConfig: (path?: string) => invoke<T.SshConfigImport>("import_ssh_config", { path }),
  exportSshConfig: (path: string) => invoke<void>("export_ssh_config", { path }),
  exportBackup: (path: string, format: "json" | "csv") => invoke<void>("export_backup", { path, format }),
  importBackup: (path: string) => invoke<T.ImportSummary>("import_backup", { path }),

  // ssh
  sshConnect: (sessionId: string, target: T.ConnectTarget, cols: number, rows: number, onData: Channel<ArrayBuffer>) =>
    invoke<T.ConnectInfo>("ssh_connect", { sessionId, target, cols, rows, onData }),
  sshWrite: (sessionId: string, data: string) => invoke<void>("ssh_write", { sessionId, data }),
  sshResize: (sessionId: string, cols: number, rows: number) => invoke<void>("ssh_resize", { sessionId, cols, rows }),
  sshClose: (sessionId: string) => invoke<void>("ssh_close", { sessionId }),
  promptRespond: (id: string, value: unknown) => invoke<void>("prompt_respond", { id, value }),

  // sftp
  sftpOpen: (sftpId: string, target: T.ConnectTarget) => invoke<T.SftpOpened>("sftp_open", { sftpId, target }),
  sftpClose: (sftpId: string) => invoke<void>("sftp_close", { sftpId }),
  sftpList: (sftpId: string, path: string) => invoke<T.RemoteEntry[]>("sftp_list", { sftpId, path }),
  sftpRealpath: (sftpId: string, path: string) => invoke<string>("sftp_realpath", { sftpId, path }),
  sftpMkdir: (sftpId: string, path: string) => invoke<void>("sftp_mkdir", { sftpId, path }),
  sftpCreateFile: (sftpId: string, path: string) => invoke<void>("sftp_create_file", { sftpId, path }),
  sftpRename: (sftpId: string, from: string, to: string) => invoke<void>("sftp_rename", { sftpId, from, to }),
  sftpRemove: (sftpId: string, paths: string[]) => invoke<void>("sftp_remove", { sftpId, paths }),
  sftpChmod: (sftpId: string, path: string, mode: number) => invoke<void>("sftp_chmod", { sftpId, path, mode }),
  sftpEdit: (sftpId: string, remotePath: string) => invoke<string>("sftp_edit", { sftpId, remotePath }),
  sftpEditStop: (sftpId: string, remotePath: string) => invoke<void>("sftp_edit_stop", { sftpId, remotePath }),
  localHome: () => invoke<string>("local_home"),
  localList: (path: string, showHidden?: boolean) => invoke<T.LocalEntry[]>("local_list", { path, showHidden }),
  localParent: (path: string) => invoke<string>("local_parent", { path }),
  openLocal: (path: string) => invoke<void>("open_local", { path }),

  // transfers
  transferUpload: (sftpId: string, localPaths: string[], remoteDir: string, priority?: number) =>
    invoke<T.TransferInfo[]>("transfer_upload", { sftpId, localPaths, remoteDir, priority }),
  transferDownload: (sftpId: string, items: { path: string; isDir: boolean }[], localDir: string, priority?: number) =>
    invoke<T.TransferInfo[]>("transfer_download", { sftpId, items, localDir, priority }),
  transfersList: () => invoke<T.TransferInfo[]>("transfers_list"),
  transferPause: (id: string) => invoke<void>("transfer_pause", { id }),
  transferResume: (id: string) => invoke<void>("transfer_resume", { id }),
  transferCancel: (id: string) => invoke<void>("transfer_cancel", { id }),
  transferSetPriority: (id: string, priority: number) => invoke<void>("transfer_set_priority", { id, priority }),
  transfersClear: () => invoke<void>("transfers_clear"),

  // account & sync
  accountInfo: () => invoke<T.AccountInfo>("account_info"),
  accountRegister: (serverUrl: string, email: string, password: string, recoveryKey?: string) =>
    invoke<void>("account_register", { serverUrl, email, password, recoveryKey }),
  accountLogin: (serverUrl: string, email: string, password: string) =>
    invoke<void>("account_login", { serverUrl, email, password }),
  accountRecover: (serverUrl: string, email: string, recoveryKey: string, newPassword: string) =>
    invoke<void>("account_recover", { serverUrl, email, recoveryKey, newPassword }),
  accountLogout: () => invoke<void>("account_logout"),
  accountDevices: () => invoke<T.Device[]>("account_devices"),
  accountRevokeDevice: (id: string) => invoke<void>("account_revoke_device", { id }),
  syncNow: () => invoke<T.SyncReport | null>("sync_now"),
};

export { Channel };

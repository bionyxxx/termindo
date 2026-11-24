/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sync server URL baked into release builds (GitHub repo variable TERMINDO_SYNC_URL). */
  readonly VITE_DEFAULT_SYNC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

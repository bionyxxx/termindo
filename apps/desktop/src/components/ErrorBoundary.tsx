import { Component, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

export function reportError(message: string) {
  console.error(message);
  void invoke("frontend_log", { level: "error", message }).catch(() => {});
}

/** Log uncaught errors to the backend so they show up in the app's log. */
export function installGlobalErrorHandlers() {
  window.addEventListener("error", (e) => reportError(`uncaught: ${e.message} at ${e.filename}:${e.lineno}:${e.colno}\n${e.error?.stack ?? ""}`));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { stack?: string; message?: string } | undefined;
    reportError(`unhandled rejection: ${r?.stack ?? r?.message ?? JSON.stringify(e.reason)}`);
  });
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(`render error: ${error.stack ?? error.message}\ncomponent stack:${info.componentStack ?? ""}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-2xl rounded-xl border border-danger/40 bg-panel p-6">
          <h1 className="text-[15px] font-semibold text-danger">Termindo hit an unexpected error</h1>
          <pre className="selectable mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-bg p-3 font-mono text-[11px] text-muted">
            {this.state.error.stack ?? this.state.error.message}
          </pre>
          <button className="mt-4 rounded-md bg-accent px-3 py-1.5 text-accent-fg" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}

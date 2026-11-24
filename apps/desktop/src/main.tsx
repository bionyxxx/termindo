import { StrictMode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import { ErrorBoundary, installGlobalErrorHandlers } from "./components/ErrorBoundary";
import { App } from "./App";
import "./index.css";

installGlobalErrorHandlers();
void invoke("frontend_log", { level: "info", message: `ui boot: ${navigator.userAgent}` }).catch(() => {});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

import { CheckCircle2, Info, XCircle, X } from "lucide-react";
import { useUi } from "../stores/ui";
import { cn } from "../lib/utils";

export function Toaster() {
  const { toasts, dismissToast } = useUi();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto flex items-start gap-2 rounded-lg border bg-panel px-3 py-2.5 text-[13px] shadow-xl",
            t.kind === "error" ? "border-danger/40" : t.kind === "success" ? "border-ok/40" : "border-line",
          )}
        >
          {t.kind === "error" ? (
            <XCircle size={16} className="mt-0.5 shrink-0 text-danger" />
          ) : t.kind === "success" ? (
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" />
          ) : (
            <Info size={16} className="mt-0.5 shrink-0 text-accent" />
          )}
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
            <span className="selectable break-words">{t.message}</span>
            {t.action && (
              <button
                className="text-xs font-medium text-accent hover:underline"
                onClick={() => {
                  t.action!.onClick();
                  dismissToast(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button className="text-muted hover:text-fg" onClick={() => dismissToast(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

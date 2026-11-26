import * as RDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "icon"; loading?: boolean }
>(({ variant = "secondary", size = "md", loading, className, children, disabled, ...rest }, ref) => (
  <button
    ref={ref}
    disabled={disabled || loading}
    className={cn(
      "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-[background-color,color,filter] outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap",
      size === "sm" && "h-8 px-3 text-[13px]",
      size === "md" && "h-9 px-3.5 text-sm",
      size === "icon" && "h-8 w-8",
      variant === "primary" && "bg-accent text-accent-fg hover:brightness-110",
      variant === "secondary" && "bg-panel-3 text-fg hover:brightness-125",
      variant === "ghost" && "text-fg-2 hover:text-fg hover:bg-panel-2",
      variant === "ghost" && size === "icon" && "bg-panel-2 hover:bg-panel-3",
      variant === "danger" && "bg-danger/12 text-danger hover:bg-danger/20",
      className,
    )}
    {...rest}
  >
    {loading && <span className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />}
    {children}
  </button>
));
Button.displayName = "Button";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => (
  <input
    ref={ref}
    spellCheck={false}
    autoCorrect="off"
    autoCapitalize="off"
    className={cn(
      "h-10 w-full rounded-lg border border-transparent bg-panel-2 px-3 text-sm text-fg placeholder:text-muted outline-none focus:border-accent focus:ring-2 focus:ring-accent/25",
      className,
    )}
    {...rest}
  />
));
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...rest }, ref) => (
    <textarea
      ref={ref}
      spellCheck={false}
      className={cn(
        "w-full rounded-lg border border-transparent bg-panel-2 px-3 py-2.5 text-sm text-fg placeholder:text-muted outline-none focus:border-accent focus:ring-2 focus:ring-accent/25",
        className,
      )}
      {...rest}
    />
  ),
);
Textarea.displayName = "Textarea";

const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237a8394' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")";

export function Select({ className, children, style, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      style={{ backgroundImage: CHEVRON, ...style }}
      className={cn(
        "h-10 w-full appearance-none rounded-lg border border-transparent bg-panel-2 bg-[length:16px] bg-[right_12px_center] bg-no-repeat pl-3 pr-9 text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent/25",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("flex flex-col gap-2", className)}>
      <span className="text-[13px] font-medium text-fg-2">{label}</span>
      {children}
      {hint && <span className="-mt-1 text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 py-1.5">
      {label && (
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-fg">{label}</span>
          {hint && <span className="text-xs text-muted">{hint}</span>}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-[22px] w-10 shrink-0 rounded-full transition-colors",
          checked ? "bg-accent" : "bg-panel-3",
        )}
      >
        <span
          className={cn(
            "absolute left-[3px] top-[3px] h-4 w-4 rounded-full transition-transform",
            checked ? "translate-x-[18px] bg-accent-fg" : "translate-x-0 bg-muted",
          )}
        />
      </button>
    </label>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  icon,
  width = "max-w-lg",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
  width?: string;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <RDialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl outline-none",
            width,
          )}
          onOpenAutoFocus={(e) => {
            const target = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("[data-autofocus]");
            if (target) {
              e.preventDefault();
              target.focus();
            }
          }}
        >
          <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
            <div className="flex items-center gap-3.5">
              {icon}
              <div>
              <RDialog.Title className="text-lg font-semibold">{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-0.5 text-[13px] text-muted">{description}</RDialog.Description>
              ) : (
                <RDialog.Description className="sr-only">{typeof title === "string" ? title : "dialog"}</RDialog.Description>
              )}
              </div>
            </div>
            <RDialog.Close className="flex h-8 w-8 items-center justify-center rounded-lg bg-panel-2 text-fg-2 hover:bg-panel-3 hover:text-fg">
              <X size={16} />
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 bg-panel-2 px-6 py-3.5">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl bg-panel py-16 text-center text-muted">
      {icon && <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-xl bg-panel-2 text-fg-2">{icon}</div>}
      <div className="text-[15px] font-semibold text-fg">{title}</div>
      {children && <div className="max-w-sm text-[13px]">{children}</div>}
    </div>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-[22px] items-center rounded-md bg-panel-3 px-2 text-xs font-medium text-fg-2", className)}>{children}</span>
  );
}

export function StatusDot({ status }: { status: "connecting" | "connected" | "closed" | "error" | "idle" }) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        status === "connected" && "bg-ok",
        status === "connecting" && "bg-warn animate-pulse-dot",
        status === "closed" && "bg-muted",
        status === "error" && "bg-danger",
        status === "idle" && "bg-panel-3",
      )}
    />
  );
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[17px] font-semibold">{children}</h2>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

/** Page header used by every library view: big title, subtitle, actions on the right. */
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-6">
      <div className="min-w-0">
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-fg">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2.5">{actions}</div>}
    </div>
  );
}

/** Rounded status chip with a dot (Connected / Connection refused …). */
export function StatusPill({ tone, children, className }: { tone: "ok" | "danger" | "warn" | "muted"; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-xs font-semibold",
        tone === "ok" && "bg-ok/12 text-ok",
        tone === "danger" && "bg-danger/12 text-danger",
        tone === "warn" && "bg-warn/12 text-warn",
        tone === "muted" && "bg-panel-3 text-fg-2",
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 items-center rounded-[5px] bg-panel-3 px-1.5 font-mono text-[11px] text-fg-2", className)}>{children}</kbd>
  );
}

/** Uppercase monospace caption ("GROUPS", "CONNECTION", table heads). */
export function Caption({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("font-mono text-[11px] uppercase tracking-[0.08em] text-muted", className)}>{children}</div>;
}

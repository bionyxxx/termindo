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
      "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap",
      size === "sm" && "h-7 px-2.5 text-xs",
      size === "md" && "h-8 px-3 text-[13px]",
      size === "icon" && "h-7 w-7",
      variant === "primary" && "bg-accent text-accent-fg hover:brightness-110",
      variant === "secondary" && "bg-panel-2 text-fg border border-line hover:bg-hover",
      variant === "ghost" && "text-muted hover:text-fg hover:bg-hover",
      variant === "danger" && "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
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
      "h-8 w-full rounded-md border border-line bg-bg px-2.5 text-[13px] text-fg placeholder:text-muted/70 outline-none focus:border-accent focus:ring-1 focus:ring-accent/40",
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
        "w-full rounded-md border border-line bg-bg px-2.5 py-2 text-[13px] text-fg placeholder:text-muted/70 outline-none focus:border-accent focus:ring-1 focus:ring-accent/40",
        className,
      )}
      {...rest}
    />
  ),
);
Textarea.displayName = "Textarea";

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-8 w-full rounded-md border border-line bg-bg px-2 text-[13px] text-fg outline-none focus:border-accent",
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
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted/80">{hint}</span>}
    </label>
  );
}

export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-1">
      {label && (
        <span className="flex flex-col">
          <span className="text-[13px]">{label}</span>
          {hint && <span className="text-[11px] text-muted">{hint}</span>}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-accent" : "bg-line",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-4" : "translate-x-0",
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
  width = "max-w-lg",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" />
        <RDialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line bg-panel shadow-2xl outline-none",
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
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
            <div>
              <RDialog.Title className="text-[15px] font-semibold">{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-0.5 text-xs text-muted">{description}</RDialog.Description>
              ) : (
                <RDialog.Description className="sr-only">{typeof title === "string" ? title : "dialog"}</RDialog.Description>
              )}
            </div>
            <RDialog.Close className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
              <X size={16} />
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted">
      {icon && <div className="text-muted/70">{icon}</div>}
      <div className="text-[14px] font-medium text-fg">{title}</div>
      {children && <div className="max-w-sm text-xs">{children}</div>}
    </div>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("rounded bg-panel-2 px-1.5 py-0.5 text-[10px] font-medium text-muted border border-line", className)}>{children}</span>;
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
        status === "idle" && "bg-line",
      )}
    />
  );
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[15px] font-semibold">{children}</h2>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

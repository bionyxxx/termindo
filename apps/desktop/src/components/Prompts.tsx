import { useEffect, useState } from "react";
import { ShieldAlert, ShieldQuestion, Copy } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../lib/api";
import { useApp } from "../stores/app";
import { toast, useUi, type ConfirmPrompt, type InputPrompt } from "../stores/ui";
import type { PromptEvent } from "../lib/types";
import { Button, Dialog, Field, Input } from "./ui";

function HostKeyPrompt({ p }: { p: Extract<PromptEvent, { kind: "hostKey" }> }) {
  const pop = useUi((s) => s.popBackendPrompt);
  const answer = (accept: boolean) => {
    void api.promptRespond(p.id, { accept });
    pop(p.id);
  };
  const changed = p.status === "changed";
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && answer(false)}
      title={
        <span className="flex items-center gap-2">
          {changed ? <ShieldAlert className="text-danger" size={18} /> : <ShieldQuestion className="text-accent" size={18} />}
          {changed ? "Host key has CHANGED" : "Unknown host"}
        </span>
      }
      footer={
        <>
          <Button onClick={() => answer(false)}>Cancel</Button>
          <Button variant={changed ? "danger" : "primary"} onClick={() => answer(true)} data-autofocus={!changed || undefined}>
            {changed ? "Accept new key" : "Trust and connect"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        {changed ? (
          <p className="rounded-md border border-danger/40 bg-danger/10 p-3 text-danger">
            The key presented by <b>{p.info.host}:{p.info.port}</b> differs from the one saved earlier. This can mean the
            server was reinstalled, or that someone is intercepting the connection. Only continue if you know why it changed.
          </p>
        ) : (
          <p className="text-muted">
            This is the first connection to <b className="text-fg">{p.label}</b> ({p.info.host}:{p.info.port}). Verify the
            fingerprint with the server administrator before trusting it.
          </p>
        )}
        <div className="rounded-md border border-line bg-bg p-3 font-mono text-xs">
          <div className="text-muted">{p.info.keyType}</div>
          <div className="selectable break-all text-fg">{p.info.fingerprint}</div>
          {changed && p.previousFingerprint && (
            <>
              <div className="mt-2 text-muted">previously ({p.previousKeyType})</div>
              <div className="selectable break-all text-muted line-through">{p.previousFingerprint}</div>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function KbdPrompt({ p }: { p: Extract<PromptEvent, { kind: "keyboardInteractive" }> }) {
  const pop = useUi((s) => s.popBackendPrompt);
  const [answers, setAnswers] = useState<string[]>(() => p.request.prompts.map(() => ""));
  const finish = (ok: boolean) => {
    void api.promptRespond(p.id, ok ? { answers } : null);
    pop(p.id);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && finish(false)}
      title={p.request.name || `Authentication for ${p.label}`}
      description={p.request.instructions || undefined}
      footer={
        <>
          <Button onClick={() => finish(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form={`kbd-${p.id}`}>
            Continue
          </Button>
        </>
      }
    >
      <form
        id={`kbd-${p.id}`}
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
      >
        {p.request.prompts.map((q, i) => (
          <Field key={i} label={q.prompt.trim() || `Response ${i + 1}`}>
            <Input
              type={q.echo ? "text" : "password"}
              value={answers[i]}
              data-autofocus={i === 0 || undefined}
              onChange={(e) => setAnswers((a) => a.map((v, j) => (j === i ? e.target.value : v)))}
            />
          </Field>
        ))}
      </form>
    </Dialog>
  );
}

function InputDialog({ p }: { p: InputPrompt }) {
  const close = useUi((s) => s.closeInput);
  const [value, setValue] = useState(p.defaultValue ?? "");
  const finish = (v: string | null) => {
    p.resolve(v);
    close(p.id);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && finish(null)}
      title={p.title}
      description={p.message}
      width="max-w-md"
      footer={
        <>
          <Button onClick={() => finish(null)}>Cancel</Button>
          <Button variant="primary" type="submit" form={`in-${p.id}`}>
            {p.confirmLabel ?? "OK"}
          </Button>
        </>
      }
    >
      <form
        id={`in-${p.id}`}
        onSubmit={(e) => {
          e.preventDefault();
          finish(value);
        }}
      >
        <Field label={p.label}>
          <Input type={p.secret ? "password" : "text"} value={value} onChange={(e) => setValue(e.target.value)} data-autofocus />
        </Field>
      </form>
    </Dialog>
  );
}

function ConfirmDialog({ p }: { p: ConfirmPrompt }) {
  const close = useUi((s) => s.closeConfirm);
  const finish = (ok: boolean) => {
    p.resolve(ok);
    close(p.id);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && finish(false)}
      title={p.title}
      width="max-w-md"
      footer={
        <>
          <Button onClick={() => finish(false)}>Cancel</Button>
          <Button variant={p.danger ? "danger" : "primary"} onClick={() => finish(true)} data-autofocus>
            {p.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-muted">{p.message}</p>
    </Dialog>
  );
}

function RecoveryKeyDialog() {
  const { recoveryKey, setRecoveryKey } = useApp();
  const [saved, setSaved] = useState(false);
  const [nudge, setNudge] = useState(false);
  useEffect(() => {
    setSaved(false);
    setNudge(false);
  }, [recoveryKey]);
  if (!recoveryKey) return null;
  // Every way out of the dialog (Done, X, Escape, Enter) closes it once the user
  // confirmed saving the key; before that it explains why it stays open.
  const close = () => {
    if (saved) setRecoveryKey(null);
    else setNudge(true);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      title="Save your recovery key"
      description="This is the only way to regain access if you forget your master password. It is shown once."
      footer={
        <Button variant="primary" disabled={!saved} onClick={close} data-autofocus={saved || undefined}>
          Done
        </Button>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          close();
        }}
      >
        <div className="selectable rounded-lg border border-accent/40 bg-bg p-4 text-center font-mono text-[15px] leading-relaxed tracking-wider text-accent">
          {recoveryKey}
        </div>
        <Button
          type="button"
          onClick={() => {
            void writeText(recoveryKey);
            toast("Recovery key copied. Store it somewhere safe (password manager, printed copy).", "success");
          }}
        >
          <Copy size={14} /> Copy to clipboard
        </Button>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => {
              setSaved(e.target.checked);
              setNudge(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                close();
              }
            }}
          />
          I saved my recovery key in a safe place
        </label>
        {nudge && <p className="text-xs text-warn">Tick the box above once you have stored the key, then close this dialog.</p>}
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

export function PromptHost() {
  const { backendPrompts, inputPrompts, confirmPrompts } = useUi();
  const bp = backendPrompts[0];
  return (
    <>
      {bp?.kind === "hostKey" && <HostKeyPrompt key={bp.id} p={bp} />}
      {bp?.kind === "keyboardInteractive" && <KbdPrompt key={bp.id} p={bp} />}
      {!bp && inputPrompts[0] && <InputDialog key={inputPrompts[0].id} p={inputPrompts[0]} />}
      {!bp && !inputPrompts[0] && confirmPrompts[0] && <ConfirmDialog key={confirmPrompts[0].id} p={confirmPrompts[0]} />}
      <RecoveryKeyDialog />
    </>
  );
}

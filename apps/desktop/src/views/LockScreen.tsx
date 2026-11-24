import { useEffect, useState } from "react";
import { KeyRound, Cloud, LifeBuoy, ShieldCheck } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useApp } from "../stores/app";
import { useSettings } from "../stores/settings";
import { Button, Field, Input } from "../components/ui";

type Mode = "create" | "unlock" | "signin" | "recoverLocal" | "recoverAccount";

function Logo() {
  return <img src="/logo.svg" alt="" className="h-14 w-14" draggable={false} />;
}

function strength(pw: string): { score: number; label: string } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return { score, label: ["Too short", "Weak", "Fair", "Good", "Strong", "Very strong"][score] };
}

export function LockScreen() {
  const { phase, vault, onUnlocked, setRecoveryKey } = useApp();
  const defaultServer = useSettings((s) => s.settings.defaultServerUrl);
  const [mode, setMode] = useState<Mode>(phase === "setup" ? "create" : "unlock");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [server, setServer] = useState(defaultServer);
  const [email, setEmail] = useState("");
  const [recovery, setRecovery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setMode(phase === "setup" ? "create" : "unlock"), [phase]);

  // Try the OS keychain once when the lock screen appears.
  useEffect(() => {
    if (phase === "locked" && vault?.keychainEnabled) {
      api
        .vaultUnlockKeychain()
        .then((ok) => {
          if (ok) void onUnlocked();
        })
        .catch(() => {});
    }
  }, [phase, vault?.keychainEnabled, onUnlocked]);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    switch (mode) {
      case "create":
        if (password.length < 8) return setError("Use at least 8 characters.");
        if (password !== confirm) return setError("Passwords do not match.");
        return run(async () => {
          const { recoveryKey } = await api.vaultCreate(password);
          setRecoveryKey(recoveryKey);
          await onUnlocked();
        });
      case "unlock":
        return run(async () => {
          await api.vaultUnlock(password);
          await onUnlocked();
        });
      case "signin":
        return run(async () => {
          await api.accountLogin(server, email, password);
          await onUnlocked();
        });
      case "recoverLocal":
        if (password !== confirm) return setError("Passwords do not match.");
        return run(async () => {
          await api.vaultRecover(recovery, password);
          await onUnlocked();
        });
      case "recoverAccount":
        if (password !== confirm) return setError("Passwords do not match.");
        return run(async () => {
          await api.accountRecover(server, email, recovery, password);
          await onUnlocked();
        });
    }
  };

  const st = strength(password);
  const titles: Record<Mode, [string, string]> = {
    create: ["Welcome to Termindo", "Create a master password. It encrypts your credentials and is never stored or sent anywhere."],
    unlock: ["Unlock your vault", "Enter your master password."],
    signin: ["Sign in to sync", "Restore your hosts and keys from your sync server. Your master password is your account password."],
    recoverLocal: ["Recover with recovery key", "Set a new master password using the recovery key you saved when creating the vault."],
    recoverAccount: ["Recover account", "Reset your account password with your recovery key."],
  };

  const needsConfirm = mode === "create" || mode === "recoverLocal" || mode === "recoverAccount";
  const needsServer = mode === "signin" || mode === "recoverAccount";

  return (
    <div className="flex h-full items-center justify-center bg-bg p-6" data-tauri-drag-region>
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-line bg-panel p-7 shadow-2xl">
        <div className="mb-5 flex flex-col items-center gap-3 text-center">
          <Logo />
          <div>
            <h1 className="text-lg font-semibold">{titles[mode][0]}</h1>
            <p className="mt-1 text-xs text-muted">{titles[mode][1]}</p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {needsServer && (
            <>
              <Field label="Sync server">
                <Input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://sync.example.com" />
              </Field>
              <Field label="Email">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
              </Field>
            </>
          )}
          {(mode === "recoverLocal" || mode === "recoverAccount") && (
            <Field label="Recovery key">
              <Input value={recovery} onChange={(e) => setRecovery(e.target.value)} placeholder="ABCD-EFGH-…" className="font-mono" autoFocus={mode === "recoverLocal"} />
            </Field>
          )}
          <Field label={needsConfirm && mode !== "create" ? "New master password" : "Master password"}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={mode === "unlock" || mode === "create"} />
          </Field>
          {needsConfirm && (
            <>
              <div className="flex items-center gap-2">
                <div className="flex h-1.5 flex-1 gap-1">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className={`flex-1 rounded ${i < st.score ? (st.score < 3 ? "bg-warn" : "bg-ok") : "bg-line"}`} />
                  ))}
                </div>
                <span className="w-20 text-right text-[11px] text-muted">{password ? st.label : ""}</span>
              </div>
              <Field label="Confirm password">
                <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </Field>
            </>
          )}
          {error && <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}
          <Button variant="primary" type="submit" loading={busy} className="mt-1 h-9">
            {mode === "create" ? "Create vault" : mode === "unlock" ? "Unlock" : mode === "signin" ? "Sign in" : "Reset password"}
          </Button>
        </div>

        <div className="mt-5 flex flex-col gap-1.5 border-t border-line pt-4 text-xs">
          {phase === "setup" && mode !== "create" && (
            <button type="button" className="flex items-center gap-2 text-muted hover:text-fg" onClick={() => setMode("create")}>
              <KeyRound size={14} /> Create a new local vault
            </button>
          )}
          {phase === "locked" && mode !== "unlock" && (
            <button type="button" className="flex items-center gap-2 text-muted hover:text-fg" onClick={() => setMode("unlock")}>
              <KeyRound size={14} /> Back to unlock
            </button>
          )}
          {phase === "setup" && mode !== "signin" && (
            <button type="button" className="flex items-center gap-2 text-muted hover:text-fg" onClick={() => setMode("signin")}>
              <Cloud size={14} /> I already have a sync account
            </button>
          )}
          {phase === "locked" && mode === "unlock" && (
            <button type="button" className="flex items-center gap-2 text-muted hover:text-fg" onClick={() => setMode("recoverLocal")}>
              <LifeBuoy size={14} /> Forgot password? Use your recovery key
            </button>
          )}
          {phase === "setup" && mode !== "recoverAccount" && (
            <button type="button" className="flex items-center gap-2 text-muted hover:text-fg" onClick={() => setMode("recoverAccount")}>
              <LifeBuoy size={14} /> Recover a sync account
            </button>
          )}
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted/80">
            <ShieldCheck size={13} /> Argon2id + XChaCha20-Poly1305, end-to-end encrypted sync
          </div>
        </div>
      </form>
    </div>
  );
}

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ChevronRight, CloudDownload, Eye, EyeOff, KeyRound, LifeBuoy, Lock, LockOpen, LogIn, RefreshCw, ScanFace, ShieldPlus } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useApp } from "../stores/app";
import { useSettings } from "../stores/settings";
import { Button, Field, Input, Switch } from "../components/ui";

type Mode = "create" | "unlock" | "signin" | "recoverLocal" | "recoverAccount";

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
  const [remember, setRemember] = useState(!!vault?.keychainEnabled);
  const [version, setVersion] = useState("");

  useEffect(() => void getVersion().then(setVersion).catch(() => {}), []);
  useEffect(() => setRemember(!!vault?.keychainEnabled), [vault?.keychainEnabled]);

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
          // Store or forget the vault key in the OS keychain as chosen on the lock screen.
          if (remember !== !!vault?.keychainEnabled) await api.vaultSetKeychain(remember).catch(() => {});
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
    create: ["Create your vault", "Your master password encrypts every credential. It is never stored or sent anywhere."],
    unlock: ["Welcome back", "Enter your master password to unlock the vault."],
    signin: ["Sign in to sync", "Restore your hosts and keys from your sync server. Your master password is your account password."],
    recoverLocal: ["Recover with recovery key", "Set a new master password using the recovery key you saved when creating the vault."],
    recoverAccount: ["Recover account", "Reset your account password with your recovery key."],
  };

  const needsConfirm = mode === "create" || mode === "recoverLocal" || mode === "recoverAccount";
  const needsServer = mode === "signin" || mode === "recoverAccount";
  // Strength meter: 4 bars (score 0–5 squeezed onto 4).
  const bars = Math.min(4, Math.ceil((st.score * 4) / 5));
  const barTone = st.score >= 4 ? "bg-ok" : st.score >= 2 ? "bg-warn" : "bg-danger";
  const labelTone = st.score >= 4 ? "text-ok" : st.score >= 2 ? "text-warn" : "text-danger";
  const SubmitIcon = mode === "create" ? ShieldPlus : mode === "unlock" ? LockOpen : mode === "signin" ? LogIn : KeyRound;

  return (
    <div className="flex h-full bg-bg">
      <aside className="flex w-[520px] shrink-0 flex-col bg-panel px-14 pb-14 pt-14" data-tauri-drag-region>
        <img src="/logo.svg" alt="" className="h-[72px] w-[72px]" draggable={false} />
        <h1 className="mt-10 text-[34px] font-bold tracking-tight text-fg">Termindo</h1>
        <p className="mt-3 max-w-[360px] text-[15px] leading-relaxed text-fg-2">
          SSH, SFTP and snippets for all your servers — encrypted on your device, synced everywhere.
        </p>
        <div className="flex-1" />
        <div className="flex flex-col gap-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="flex items-center gap-3.5 rounded-[10px] bg-panel-2 px-3.5 py-3.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
                <f.icon size={16} />
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-fg">{f.title}</span>
                <span className="text-xs text-muted">{f.desc}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="flex-1" />
        <span className="font-mono text-xs text-muted">{version ? `v${version}` : ""}</span>
      </aside>

      <div className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto p-8" data-tauri-drag-region>
        <form onSubmit={submit} className="flex w-full max-w-[380px] flex-col">
          <h2 className="text-[28px] font-bold tracking-tight text-fg">{titles[mode][0]}</h2>
          <p className="mt-2 text-sm leading-relaxed text-fg-2">{titles[mode][1]}</p>

          <div className="mt-5 flex flex-col gap-4">
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
            <div className="flex flex-col gap-2">
              <Field label={needsConfirm && mode !== "create" ? "New master password" : "Master password"}>
                <PasswordInput value={password} onChange={setPassword} autoFocus={mode === "unlock" || mode === "create"} />
              </Field>
              {needsConfirm && (
                <>
                  <div className="mt-1 flex h-1.5 gap-1.5">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className={`flex-1 rounded-full ${password && i < bars ? barTone : "bg-panel-3"}`} />
                    ))}
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className={`font-semibold ${password ? labelTone : "text-muted"}`}>{password ? st.label : "At least 8 characters"}</span>
                    <span className="text-muted">{password.length} characters</span>
                  </div>
                </>
              )}
            </div>
            {needsConfirm && (
              <Field label="Confirm password">
                <PasswordInput value={confirm} onChange={setConfirm} />
              </Field>
            )}
            {error && <div className="rounded-lg bg-danger/12 px-3 py-2.5 text-[13px] text-danger">{error}</div>}
            <Button variant="primary" type="submit" loading={busy} className="mt-1 h-11 w-full rounded-lg text-[15px]">
              {!busy && <SubmitIcon size={16} />}
              {mode === "create" ? "Create vault" : mode === "unlock" ? "Unlock" : mode === "signin" ? "Sign in" : "Reset password"}
            </Button>

            {mode === "unlock" && (
              <>
                <label className="flex cursor-pointer items-center gap-3 rounded-[10px] bg-panel px-3.5 py-3">
                  <ScanFace size={16} className="shrink-0 text-fg-2" />
                  <span className="flex-1 text-[13px] text-fg-2">Remember on this device (OS keychain)</span>
                  <Switch checked={remember} onChange={setRemember} />
                </label>
                <div className="flex items-center justify-center gap-2 text-[13px] text-muted">
                  <LifeBuoy size={14} /> Forgot password?
                  <button type="button" className="font-semibold text-accent hover:underline" onClick={() => setMode("recoverLocal")}>
                    Use recovery key
                  </button>
                </div>
              </>
            )}

            <div className="flex flex-col gap-2">
              {phase === "setup" && mode !== "create" && <LinkRow icon={KeyRound} label="Create a new local vault" onClick={() => setMode("create")} />}
              {phase === "locked" && mode !== "unlock" && <LinkRow icon={KeyRound} label="Back to unlock" onClick={() => setMode("unlock")} />}
              {phase === "setup" && mode !== "signin" && <LinkRow icon={CloudDownload} label="I already have a sync account" onClick={() => setMode("signin")} />}
              {phase === "setup" && mode !== "recoverAccount" && <LinkRow icon={LifeBuoy} label="Recover a sync account" onClick={() => setMode("recoverAccount")} />}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

const FEATURES = [
  { icon: Lock, title: "Zero-knowledge vault", desc: "Argon2id key derivation, XChaCha20-Poly1305" },
  { icon: RefreshCw, title: "End-to-end sync", desc: "Only ciphertext ever reaches the server" },
  { icon: KeyRound, title: "Your keys stay yours", desc: "Private keys never leave the vault unencrypted" },
];

function LinkRow({ icon: Icon, label, onClick }: { icon: typeof Lock; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-10 items-center gap-2.5 rounded-lg bg-panel px-3 text-left text-[13px] text-fg-2 hover:text-fg">
      <Icon size={16} />
      <span className="flex-1">{label}</span>
      <ChevronRight size={16} className="text-muted" />
    </button>
  );
}

function PasswordInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} className="h-11 pr-10" />
      <button
        type="button"
        tabIndex={-1}
        title={show ? "Hide" : "Show"}
        onClick={() => setShow((v) => !v)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-fg"
      >
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

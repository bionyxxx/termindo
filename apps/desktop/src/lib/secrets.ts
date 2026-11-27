// Passwords and passphrases typed while connecting. A connection through jump
// hosts can need one per host, so they are kept apart.

import { errorCode, errorHostId, errorMessage } from "./api";
import type { ConnectTarget } from "./types";

export interface SecretRequest {
  /** Jump host the secret is for; undefined for the target itself. */
  hostId?: string;
  title: string;
  label: string;
  message: string;
}

/** Kept in memory only, for reconnects. */
export class PromptedSecrets {
  private password: string | null = null;
  private readonly jumpPasswords: Record<string, string> = {};

  addTo(target: ConnectTarget): ConnectTarget {
    return { ...target, password: this.password, jumpPasswords: { ...this.jumpPasswords } };
  }

  /** What to ask the user after a failed connect, or null if asking would not help. */
  request(e: unknown, title: string): SecretRequest | null {
    const code = errorCode(e);
    const hostId = errorHostId(e);
    const typed = hostId ? this.jumpPasswords[hostId] : this.password;
    // A rejected secret is only worth asking again if the user typed it.
    const rejected = code === "auth_failed" && typed != null;
    if (!rejected && code !== "password_required" && code !== "passphrase_required") return null;
    const label = code === "passphrase_required" ? "Passphrase" : "Password";
    let message = errorMessage(e);
    if (rejected) message = `${hostId ? message : `Authentication failed for ${title}`}. Try again.`;
    return { hostId, title: label === "Passphrase" ? "Key passphrase" : label, label, message };
  }

  set(hostId: string | undefined, value: string) {
    if (hostId) this.jumpPasswords[hostId] = value;
    else this.password = value;
  }
}

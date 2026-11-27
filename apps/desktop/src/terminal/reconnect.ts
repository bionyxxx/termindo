// Retry schedule for auto-reconnect: starts when a connection drops and keeps
// going while attempts fail for network reasons.

export const MAX_RECONNECTS = 5;

/** Error codes worth another attempt. Auth and host key errors need the user. */
const RETRYABLE = new Set(["connect_failed", "timeout", "ssh"]);

export interface Retry {
  attempt: number;
  delayMs: number;
}

export class Reconnector {
  private attempts = 0;
  private active = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly connect: () => void) {}

  /** The connection dropped unexpectedly. Returns the scheduled retry, if any. */
  dropped(): Retry | null {
    this.active = true;
    return this.schedule();
  }

  /** A connect attempt failed. Returns null if no further retry was scheduled. */
  failed(code: string | undefined): Retry | null {
    if (!this.active) return null;
    if (code && RETRYABLE.has(code)) return this.schedule();
    this.stop();
    return null;
  }

  /** The user retries now: drop the pending timer and allow a full set of attempts again. */
  retryNow() {
    clearTimeout(this.timer);
    this.attempts = 0;
  }

  /** Connected, cancelled or closed: forget the sequence. */
  stop() {
    this.retryNow();
    this.active = false;
  }

  private schedule(): Retry | null {
    clearTimeout(this.timer);
    if (this.attempts >= MAX_RECONNECTS) {
      this.stop();
      return null;
    }
    const delayMs = Math.min(30000, 1000 * 2 ** this.attempts);
    this.attempts++;
    this.timer = setTimeout(this.connect, delayMs);
    return { attempt: this.attempts, delayMs };
  }
}

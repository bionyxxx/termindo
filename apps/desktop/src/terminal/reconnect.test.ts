import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RECONNECTS, Reconnector } from "./reconnect";

describe("Reconnector", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("keeps retrying with backoff while the network is down, then gives up", () => {
    const delays: number[] = [];
    const connect = vi.fn();
    const r = new Reconnector(connect);
    let retry = r.dropped();
    while (retry) {
      delays.push(retry.delayMs);
      vi.advanceTimersByTime(retry.delayMs);
      retry = r.failed("connect_failed");
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(connect).toHaveBeenCalledTimes(MAX_RECONNECTS);
    // Given up: a later manual attempt that fails does not start again.
    expect(r.failed("timeout")).toBeNull();
  });

  it("does not retry a failed attempt unless a connection dropped", () => {
    const r = new Reconnector(vi.fn());
    expect(r.failed("connect_failed")).toBeNull();
    r.dropped();
    r.stop();
    expect(r.failed("connect_failed")).toBeNull();
  });

  it("stops on errors that need the user", () => {
    for (const code of ["auth_failed", "host_key_rejected", "vault_locked", undefined]) {
      const connect = vi.fn();
      const r = new Reconnector(connect);
      r.dropped();
      vi.advanceTimersByTime(1000);
      expect(r.failed(code)).toBeNull();
      expect(r.failed("timeout")).toBeNull();
      vi.runAllTimers();
      expect(connect).toHaveBeenCalledTimes(1);
    }
  });

  it("starts over after a manual retry and cancels the pending timer", () => {
    const connect = vi.fn();
    const r = new Reconnector(connect);
    r.dropped();
    vi.advanceTimersByTime(1000);
    r.failed("timeout");
    r.retryNow();
    vi.runAllTimers();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(r.failed("timeout")).toEqual({ attempt: 1, delayMs: 1000 });
  });

  it("cancels the pending timer when stopped", () => {
    const connect = vi.fn();
    const r = new Reconnector(connect);
    r.dropped();
    r.stop();
    vi.runAllTimers();
    expect(connect).not.toHaveBeenCalled();
  });
});

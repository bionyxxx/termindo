import { describe, expect, it } from "vitest";
import { PromptedSecrets } from "./secrets";

const required = (hostId?: string) => ({ code: "password_required", message: "password required", hostId });
const failed = (hostId?: string) => ({ code: "auth_failed", message: "authentication failed", hostId });

describe("PromptedSecrets", () => {
  it("keeps the target and each jump host apart", () => {
    const s = new PromptedSecrets();
    expect(s.request(required("jump"), "web")?.hostId).toBe("jump");
    s.set("jump", "j");
    expect(s.request(required(), "web")?.hostId).toBeUndefined();
    s.set(undefined, "t");
    expect(s.addTo({ hostId: "web" })).toEqual({ hostId: "web", password: "t", jumpPasswords: { jump: "j" } });
  });

  it("asks again only for a rejected secret the user typed", () => {
    const s = new PromptedSecrets();
    expect(s.request(failed(), "web")).toBeNull();
    expect(s.request(failed("jump"), "web")).toBeNull();
    s.set("jump", "wrong");
    expect(s.request(failed("jump"), "web")?.message).toBe("authentication failed. Try again.");
    // The jump host's secret being typed says nothing about the target's.
    expect(s.request(failed(), "web")).toBeNull();
    s.set(undefined, "wrong");
    expect(s.request(failed(), "web")?.message).toBe("Authentication failed for web. Try again.");
  });

  it("labels passphrase prompts and ignores other errors", () => {
    const s = new PromptedSecrets();
    expect(s.request({ code: "passphrase_required", message: "m" }, "web")).toMatchObject({ title: "Key passphrase", label: "Passphrase" });
    expect(s.request({ code: "timeout", message: "m" }, "web")).toBeNull();
  });
});

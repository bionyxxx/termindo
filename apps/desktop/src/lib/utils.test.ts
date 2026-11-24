import { describe, expect, it } from "vitest";
import { customPlaceholders, formatBytes, joinRemote, parentRemote, permString } from "./utils";

describe("utils", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50 MB");
  });
  it("handles remote paths", () => {
    expect(joinRemote("/", "a")).toBe("/a");
    expect(joinRemote("/home/u", "a")).toBe("/home/u/a");
    expect(parentRemote("/home/u/a")).toBe("/home/u");
    expect(parentRemote("/home")).toBe("/");
    expect(parentRemote("/")).toBe("/");
  });
  it("renders permissions", () => {
    expect(permString(0o755, true)).toBe("drwxr-xr-x");
    expect(permString(0o644, false)).toBe("-rw-r--r--");
  });
  it("finds custom placeholders", () => {
    expect(customPlaceholders("ssh {{user}}@{{ host }} {{ msg }} {{msg}} {{bad")).toEqual(["msg"]);
  });
});

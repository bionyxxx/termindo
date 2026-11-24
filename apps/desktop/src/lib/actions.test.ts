import { describe, expect, it } from "vitest";
import { parseQuick } from "./actions";

describe("parseQuick", () => {
  it("parses user@host:port", () => {
    expect(parseQuick("root@10.0.0.1:2222")).toEqual({ username: "root", hostname: "10.0.0.1", port: 2222 });
    expect(parseQuick("example.com")).toEqual({ username: "", hostname: "example.com", port: 22 });
    expect(parseQuick("ssh deploy@web-1.internal")).toEqual({ username: "deploy", hostname: "web-1.internal", port: 22 });
    expect(parseQuick("not a host")).toBeNull();
  });
});

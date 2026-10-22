import { describe, expect, it } from "vitest";
import { extractPostizKey } from "../src/main.js";

describe("extractPostizKey", () => {
  it("unwraps the Bearer token Composio sends", () => {
    expect(extractPostizKey("Bearer pk_abc123")).toBe("pk_abc123");
    expect(extractPostizKey("bearer pk_abc123")).toBe("pk_abc123");
    expect(extractPostizKey(["Bearer pk_abc123"])).toBe("pk_abc123");
  });

  it("passes a raw key through (curl debugging without Bearer)", () => {
    expect(extractPostizKey("pk_abc123")).toBe("pk_abc123");
    expect(extractPostizKey("  pk_abc123  ")).toBe("pk_abc123");
  });

  it("rejects missing or empty credentials", () => {
    expect(extractPostizKey(undefined)).toBeNull();
    expect(extractPostizKey("")).toBeNull();
    expect(extractPostizKey("   ")).toBeNull();
    expect(extractPostizKey("Bearer ")).toBeNull();
  });
});

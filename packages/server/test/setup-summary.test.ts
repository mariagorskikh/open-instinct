import { describe, expect, it } from "vitest";
import { appsNotConfiguredTool, setupSummaryFor } from "../src/setup-summary.js";
import type { ToolContext } from "@open-instinct/core";

describe("setup summary", () => {
  it("says plainly what is missing", () => {
    const text = setupSummaryFor({});
    expect(text).toContain("Messaging: no Inkbox identity");
    expect(text).toContain("Apps: not set up");
    expect(text).toContain("COMPOSIO_API_KEY");
    expect(text).toContain("Computer: none");
    expect(text).toContain("Payments: not set up");
  });
  it("describes a fully wired agent", () => {
    const text = setupSummaryFor({ inkbox: { handle: "maria-instinct" }, computerKind: "desktopd", apps: { connected: ["gmail"], anyApp: true, toolkits: [] }, wallet: { connected: true } });
    expect(text).toContain("@maria-instinct");
    expect(text).toContain("own Linux desktop");
    expect(text).toContain("any app by name");
    expect(text).toContain("Connected: gmail");
    expect(text).toContain("wallet connected");
  });
  it("the stand-in apps_connect names the missing key instead of a screen", async () => {
    const tool = appsNotConfiguredTool();
    const ctx = { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Maria" }, conversationKey: "imessage:1", channel: "imessage", now: () => new Date() } as unknown as ToolContext;
    const out = await tool.spec.execute({ toolkit: "gmail" }, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain("COMPOSIO_API_KEY");
    expect(text).toContain("gmail");
    expect(text).not.toMatch(/settings page/i);
  });
  it("tells a browser-only agent it cannot get past logins or take payments", () => {
    const text = setupSummaryFor({ computerKind: "browser" });
    expect(text).toContain("headless web browser of your own");
    expect(text).toContain("nobody can take it over");
    expect(text).toContain("You cannot pay for anything");
    expect(text).not.toContain("desktop takeover");
  });
});

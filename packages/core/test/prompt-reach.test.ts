import { describe, expect, it } from "vitest";
import { buildSystemPrompt, defaultConfig, describePromptLayers } from "../src/index.js";
import type { Principal } from "../src/index.js";

const owner: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Maria" };
const sam: Principal = { kind: "contact", id: "contact:sam", tier: "friend", displayName: "Sam", contactId: "sam" };
const base = { config: defaultConfig(), now: new Date("2026-10-04T12:00:00Z"), capabilities: [], toolGroups: [], memoryDigest: "" };

describe("everything happens in this chat", () => {
  it("tells the owner's agent how links, files and takeovers travel", () => {
    const text = buildSystemPrompt({ ...base, principal: owner, channel: "imessage" });
    expect(text).toContain("# Everything happens in this chat");
    expect(text).toContain("apps_connect");
    expect(text).toContain("send_file");
    expect(text).toContain("request_takeover");
    expect(text).toContain("Never describe your own machinery");
  });
  it("offers a takeover link only when the request_takeover tool exists", () => {
    const desktop = buildSystemPrompt({ ...base, principal: owner, channel: "imessage", toolNames: ["request_takeover", "send_file"] });
    expect(desktop).toContain("call request_takeover and send the link");
    const browserOnly = buildSystemPrompt({ ...base, principal: owner, channel: "imessage", toolNames: ["browser_navigate", "send_file"] });
    expect(browserOnly).not.toContain("call request_takeover and send the link");
    expect(browserOnly).toContain("There is no takeover on this agent");
    expect(browserOnly).toContain("you must not offer a takeover link");
  });
  it("gives non-owners the short version without connect or takeover links", () => {
    const text = buildSystemPrompt({ ...base, principal: sam, channel: "imessage" });
    expect(text).toContain("# Everything happens in this thread");
    expect(text).toContain("Sam (friend)");
    expect(text).not.toContain("call apps_connect");
  });
  it("renders the setup section when the server supplies it", () => {
    const layers = describePromptLayers({ ...base, principal: owner, channel: "imessage", setup: "# What is set up right now\n- Apps: not set up." });
    const setup = layers.find((l) => l.id === "setup");
    expect(setup?.text).toContain("Apps: not set up");
    expect(layers.findIndex((l) => l.id === "reach")).toBeLessThan(layers.findIndex((l) => l.id === "setup"));
  });
});

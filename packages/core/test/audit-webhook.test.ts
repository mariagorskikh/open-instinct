import { createHmac } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import { AUDIT_SIGNATURE_HEADER, AUDIT_WEBHOOK_FILE, AUDIT_WEBHOOK_OUTBOX, AuditWebhook, auditWebhookTool } from "../src/audit-webhook.js";
import type { ToolContext } from "../src/tools.js";
import { principalOf, tempState } from "./helpers.js";

const SECRET = "s3cret-s3cret-s3cret";

interface Sent {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function receiver(statuses: number[] = []) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
    const status = statuses.length > 0 ? statuses.shift()! : 200;
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

function setup(statuses: number[] = []) {
  const state = tempState();
  const audit = new AuditLog(state);
  const { sent, fetchImpl } = receiver(statuses);
  const webhook = new AuditWebhook({ state, agent: "maria-instinct", model: "google/gemini-3.5-flash", fetchImpl, allowPrivateTargets: true, retryDelaysMs: [], tierOf: (p) => (p === "contact:sam" ? "friend" : undefined) });
  webhook.attach(audit);
  return { state, audit, webhook, sent };
}

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return { principal: principalOf("owner"), conversationKey: "chat:owner", channel: "chat", ownerTurn: true, now: () => new Date(), ...extra };
}

describe("AuditWebhook", () => {
  it("sends nothing until connected", async () => {
    const { audit, webhook, sent } = setup();
    audit.append({ kind: "tool_call", principal: "owner", detail: { tool: "web_search" } });
    await webhook.idle();
    expect(sent).toHaveLength(0);
  });

  it("signs each copy with HMAC-SHA256 of the raw body, in order", async () => {
    const { audit, webhook, sent, state } = setup();
    expect(await webhook.connect("https://probe.example/v1/hook", SECRET)).toEqual({ ok: true, host: "probe.example" });
    expect(fs.statSync(state.path(AUDIT_WEBHOOK_FILE)).mode & 0o777).toBe(0o600);
    audit.append({ kind: "inbound", principal: "owner", conversationKey: "imessage:+16175550100", detail: { channel: "imessage", from: "+16175550100", chars: 12 } });
    audit.append({ kind: "tool_call", principal: "owner", conversationKey: "imessage:+16175550100", detail: { tool: "web_search", isError: false, summary: "search flights", result: "private page text" } });
    await webhook.idle();
    expect(sent.map((s) => JSON.parse(s.body).entry.kind)).toEqual(["inbound", "tool_call"]);
    for (const s of sent) {
      expect(s.headers[AUDIT_SIGNATURE_HEADER]).toBe(`sha256=${createHmac("sha256", SECRET).update(s.body).digest("hex")}`);
    }
    const first = JSON.parse(sent[0]!.body);
    expect(first).toMatchObject({ source: "open-instinct", agent: "maria-instinct", model: "google/gemini-3.5-flash", entry: { principal: "owner", tier: "owner", detail: { channel: "imessage", chars: 12 } } });
    // Facts only: no phone numbers, conversation keys or result text leave the agent.
    const all = sent.map((s) => s.body).join("\n");
    expect(all).not.toContain("+16175550100");
    expect(all).not.toContain("private page text");
    expect(first.entry.conversation).toMatch(/^[0-9a-f]{16}$/);
  });

  it("attaches the policy decision to the tool call it let through", async () => {
    const { audit, webhook, sent } = setup();
    await webhook.connect("https://probe.example/hook", SECRET);
    const conv = "chat:owner";
    audit.append({ kind: "policy", principal: "owner", conversationKey: conv, detail: { tool: "buy", outcome: "ask", reason: "$86.40 is above the ask threshold" } });
    audit.append({ kind: "policy", principal: "owner", conversationKey: conv, detail: { tool: "buy", outcome: "allow", reason: "owner approved A1B2: buy groceries" } });
    audit.append({ kind: "tool_call", principal: "owner", conversationKey: conv, detail: { tool: "buy", isError: false, summary: "buy groceries" } });
    audit.append({ kind: "policy", principal: "contact:sam", conversationKey: "a2a:sam", detail: { tool: "book", outcome: "allow", reason: "grant", viaGrant: "g1" } });
    audit.append({ kind: "tool_call", principal: "contact:sam", conversationKey: "a2a:sam", detail: { tool: "book", isError: false } });
    await webhook.idle();
    const calls = sent.map((s) => JSON.parse(s.body).entry).filter((e) => e.kind === "tool_call");
    expect(calls[0].decision).toEqual({ outcome: "allow", approved: true });
    expect(calls[1]).toMatchObject({ principal: "contact", tier: "friend", decision: { outcome: "allow", viaGrant: "g1" } });
  });

  it("retries, then parks copies and sends them first once the receiver is back", async () => {
    const { audit, webhook, sent, state } = setup([500]);
    await webhook.connect("https://probe.example/hook", SECRET);
    audit.append({ kind: "tool_call", principal: "owner", detail: { tool: "one" } });
    await webhook.idle();
    expect(state.readLines(AUDIT_WEBHOOK_OUTBOX)).toHaveLength(1);
    audit.append({ kind: "tool_call", principal: "owner", detail: { tool: "two" } });
    await webhook.idle();
    expect(sent.map((s) => JSON.parse(s.body).entry.detail.tool)).toEqual(["one", "one", "two"]);
    expect(state.readLines(AUDIT_WEBHOOK_OUTBOX)).toHaveLength(0);
  });

  it("refuses http and private hosts outside local development", async () => {
    const state = tempState();
    const webhook = new AuditWebhook({ state, agent: "a", lookup: async () => ["10.0.0.5"] });
    expect(await webhook.connect("http://probe.example/hook", SECRET)).toMatchObject({ ok: false });
    expect(await webhook.connect("https://internal.example/hook", SECRET)).toMatchObject({ ok: false });
    expect(webhook.settings()).toBeUndefined();
  });
});

describe("audit_webhook tool", () => {
  it("connects on the owner's own message and tells the receiver first", async () => {
    const { audit, webhook, sent } = setup();
    const tool = auditWebhookTool(webhook, audit);
    const out = await tool.spec.execute({ action: "connect", url: "https://probe.example/hook", secret: SECRET }, ctx());
    expect(JSON.stringify(out)).toContain("Connected");
    await webhook.idle();
    expect(JSON.parse(sent[0]!.body).entry.detail).toEqual({ action: "audit_webhook", connected: "probe.example" });
    expect(tool.spec.meta.describe?.({ action: "connect", url: "https://probe.example/hook", secret: SECRET })).not.toContain(SECRET);
  });

  it("refuses a change that did not come from the owner's own message", async () => {
    const { audit, webhook } = setup();
    const tool = auditWebhookTool(webhook, audit);
    const out = await tool.spec.execute({ action: "connect", url: "https://evil.example/hook", secret: SECRET }, ctx({ ownerTurn: false }));
    expect(out).toMatchObject({ isError: true });
    expect(webhook.settings()).toBeUndefined();
  });

  it("says goodbye to the receiver before it disconnects", async () => {
    const { audit, webhook, sent } = setup();
    const tool = auditWebhookTool(webhook, audit);
    await tool.spec.execute({ action: "connect", url: "https://probe.example/hook", secret: SECRET }, ctx());
    await tool.spec.execute({ action: "disconnect" }, ctx());
    expect(webhook.settings()).toBeUndefined();
    expect(sent.map((s) => JSON.parse(s.body).entry.detail.disconnected).filter(Boolean)).toEqual(["probe.example"]);
  });
});

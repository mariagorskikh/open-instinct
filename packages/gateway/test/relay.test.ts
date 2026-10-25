import { describe, expect, it } from "vitest";
import { EventDeduper, conversationIdOf, isDeliveryEvent, relayEvent } from "../src/relay.js";
import { fakeMaritime, imessageEvent, readyUser, signHeaders } from "./helpers.js";

const PREFIX = "@@instinct-event@@";

function deps(mar = fakeMaritime()) {
  return {
    mar,
    deps: {
      maritime: { apiKey: "mk_test", baseUrl: "https://maritime.test/" },
      fetchImpl: mar.fetch,
      dedupe: new EventDeduper(10),
      retry: { sleep: async () => undefined },
    },
  };
}

describe("relayEvent", () => {
  it("forwards a signed event as an envelope to the user's agent", async () => {
    const d = deps();
    const user = readyUser();
    const raw = Buffer.from(JSON.stringify(imessageEvent("evt_1", "conv_9")));
    const r = await relayEvent(user, raw, signHeaders(raw, user.signingKey), d.deps);
    expect(r).toEqual({ status: "forwarded" });
    expect(d.mar.calls).toHaveLength(1);
    const call = d.mar.calls[0]!;
    expect(call.url).toBe("https://maritime.test/api/agents/agt_42/chat");
    expect(call.headers["authorization"]).toBe("Bearer mk_test");
    expect(call.body).toEqual({ message: PREFIX + raw.toString("utf8"), conversation_id: "conv_9" });
    expect(JSON.parse((call.body as { message: string }).message.slice(PREFIX.length))).toEqual(imessageEvent("evt_1", "conv_9"));
  });

  it("rejects a bad signature and a stale timestamp without calling Maritime", async () => {
    const d = deps();
    const user = readyUser();
    const raw = Buffer.from(JSON.stringify(imessageEvent()));
    expect(await relayEvent(user, raw, signHeaders(raw, "whsec_other"), d.deps)).toEqual({ status: "rejected", reason: "invalid signature" });
    expect(await relayEvent(user, raw, {}, d.deps)).toMatchObject({ status: "rejected" });
    const tampered = Buffer.from(JSON.stringify(imessageEvent("evt_2")));
    expect(await relayEvent(user, tampered, signHeaders(raw, user.signingKey), d.deps)).toMatchObject({ status: "rejected" });
    const stale = signHeaders(raw, user.signingKey, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(await relayEvent(user, raw, stale, d.deps)).toMatchObject({ status: "rejected" });
    expect(d.mar.calls).toHaveLength(0);
  });

  it("accepts the subscription signing key as a fallback", async () => {
    const d = deps();
    const user = readyUser({ webhookSigningKey: "whsec_sub" });
    const raw = Buffer.from(JSON.stringify(imessageEvent()));
    expect(await relayEvent(user, raw, signHeaders(raw, "whsec_sub"), d.deps)).toEqual({ status: "forwarded" });
  });

  it("ignores delivery status events", async () => {
    const d = deps();
    const user = readyUser();
    for (const type of ["imessage.delivered", "imessage.sent", "text.delivery_status", "message.sent", "imessage.failed"]) {
      const raw = Buffer.from(JSON.stringify({ ...imessageEvent(`evt_${type}`), event_type: type }));
      expect(await relayEvent(user, raw, signHeaders(raw, user.signingKey), d.deps)).toMatchObject({ status: "ignored" });
    }
    expect(isDeliveryEvent("a2a.sent_task.updated")).toBe(false);
    expect(isDeliveryEvent("imessage.received")).toBe(false);
    expect(d.mar.calls).toHaveLength(0);
  });

  it("ignores a duplicate event id", async () => {
    const d = deps();
    const user = readyUser();
    const raw = Buffer.from(JSON.stringify(imessageEvent("evt_dup")));
    const headers = signHeaders(raw, user.signingKey);
    expect(await relayEvent(user, raw, headers, d.deps)).toEqual({ status: "forwarded" });
    expect(await relayEvent(user, raw, headers, d.deps)).toEqual({ status: "ignored", reason: "duplicate" });
    expect(d.mar.calls).toHaveLength(1);
  });

  it("rejects malformed json and ignores users without an agent", async () => {
    const d = deps();
    const user = readyUser();
    const raw = Buffer.from("{not json");
    expect(await relayEvent(user, raw, signHeaders(raw, user.signingKey), d.deps)).toEqual({ status: "rejected", reason: "invalid json" });
    const ok = Buffer.from(JSON.stringify(imessageEvent("evt_noagent")));
    expect(await relayEvent(readyUser({ maritimeAgentId: undefined, status: "provisioning" }), ok, signHeaders(ok, user.signingKey), d.deps)).toMatchObject({ status: "ignored", reason: "agent not provisioned" });
    // The id was released, so the same event goes through once the agent exists.
    expect(await relayEvent(user, ok, signHeaders(ok, user.signingKey), d.deps)).toEqual({ status: "forwarded" });
  });

  it("marks a spent budget as the cause and does not retry it", async () => {
    const user = readyUser();
    const raw = Buffer.from(JSON.stringify(imessageEvent("evt_budget")));
    for (const response of [
      "This agent can't be woken right now: This agent reached its monthly AI spend limit ($10.03 of $10.00). The limit resets on 2026-11-01 (UTC).",
      "This agent couldn't be woken: LLM credits exhausted ($1081.68 of $1080.00 used).",
    ]) {
      const d = deps();
      d.mar.queue.push({ body: { response } });
      const r = await relayEvent(user, raw, signHeaders(raw, user.signingKey), d.deps);
      expect(r.status).toBe("rejected");
      expect(r.cause).toBe("budget");
      expect(r.reason).toContain("maritime:");
      expect(d.mar.calls).toHaveLength(1);
    }
    // Other platform replies keep their retries and carry no cause.
    const d = deps();
    d.mar.queue.push({ body: { response: "This agent couldn't be woken: VM not found" } }, { body: { response: "This agent couldn't be woken: VM not found" } }, { body: { response: "This agent couldn't be woken: VM not found" } });
    const r = await relayEvent(user, raw, signHeaders(raw, user.signingKey), d.deps);
    expect(r.status).toBe("rejected");
    expect(r.cause).toBeUndefined();
    expect(d.mar.calls).toHaveLength(3);
  });

  it("retries on 503, 429 and network errors, then succeeds", async () => {
    const d = deps();
    d.mar.queue.push(503, new Error("ECONNRESET"));
    const user = readyUser();
    const raw = Buffer.from(JSON.stringify(imessageEvent("evt_retry")));
    expect(await relayEvent(user, raw, signHeaders(raw, user.signingKey), d.deps)).toEqual({ status: "forwarded" });
    expect(d.mar.calls).toHaveLength(3);

    const d2 = deps();
    d2.mar.queue.push(429, 503, 503);
    const r = await relayEvent(user, raw, signHeaders(raw, user.signingKey), d2.deps);
    expect(r.status).toBe("rejected");
    expect(r.reason).toContain("after 3 attempts");
    expect(d2.mar.calls).toHaveLength(3);
    // A failed forward releases the id so a replay is possible.
    expect(d2.deps.dedupe.size).toBe(0);
  });

  it("treats a Maritime delivery error body as transient", async () => {
    const d = deps();
    d.mar.queue.push({ body: { response: null, error: "agent not reachable" } });
    const user = readyUser();
    const raw = Buffer.from(JSON.stringify(imessageEvent("evt_err")));
    expect(await relayEvent(user, raw, signHeaders(raw, user.signingKey), d.deps)).toEqual({ status: "forwarded" });
    expect(d.mar.calls).toHaveLength(2);
  });

  it("does not retry a 4xx that is not rate limiting", async () => {
    const d = deps();
    d.mar.queue.push(404);
    const user = readyUser();
    const raw = Buffer.from(JSON.stringify(imessageEvent("evt_404")));
    expect(await relayEvent(user, raw, signHeaders(raw, user.signingKey), d.deps)).toEqual({ status: "rejected", reason: "maritime 404" });
    expect(d.mar.calls).toHaveLength(1);
  });
});

describe("conversationIdOf", () => {
  it("picks the inkbox thread id for each channel", () => {
    expect(conversationIdOf(imessageEvent("e", "conv_1"))).toBe("conv_1");
    expect(conversationIdOf({ event_type: "a2a.task.created", data: { task_id: "t", context_id: "ctx_1" } })).toBe("ctx_1");
    expect(conversationIdOf({ event_type: "message.received", data: { message: { thread_id: "thr_1" } } })).toBe("thr_1");
    expect(conversationIdOf({ event_type: "text.received", data: { message: { conversation_key: "+1415" } } })).toBe("+1415");
    expect(conversationIdOf({ event_type: "text.received", data: {} })).toBe("inkbox:text");
  });
});

describe("EventDeduper", () => {
  it("evicts the oldest id past its cap", () => {
    const d = new EventDeduper(3);
    expect(d.seen("a")).toBe(false);
    d.seen("b");
    d.seen("c");
    d.seen("d");
    expect(d.size).toBe(3);
    expect(d.seen("a")).toBe(false);
    expect(d.seen("d")).toBe(true);
  });
});

describe("agent readiness", () => {
  it("holds a message for a brand-new agent that Maritime says is still deploying, and forgets the id so it can be retried", async () => {
    const d = deps();
    d.mar.agentStatus["agt_42"] = "deploying";
    const user = readyUser({ createdAt: new Date().toISOString() });
    const raw = Buffer.from(JSON.stringify(imessageEvent("evt_young", "conv_1")));
    expect(await relayEvent(user, raw, signHeaders(raw, user.signingKey), d.deps)).toEqual({ status: "rejected", reason: "agent deploying" });
    expect(d.mar.calls.map((c) => c.method)).toEqual(["GET"]);
    d.mar.agentStatus["agt_42"] = "active";
    expect(await relayEvent(user, raw, signHeaders(raw, user.signingKey), d.deps)).toEqual({ status: "forwarded" });
    expect(d.mar.calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
  });

  it("skips the status check for an agent older than the window, and can be forced on or off", async () => {
    const d = deps();
    d.mar.agentStatus["agt_42"] = "deploying";
    const old = readyUser();
    const raw = Buffer.from(JSON.stringify(imessageEvent("evt_old", "conv_1")));
    expect(await relayEvent(old, raw, signHeaders(raw, old.signingKey), d.deps)).toEqual({ status: "forwarded" });
    expect(d.mar.calls.map((c) => c.method)).toEqual(["POST"]);
    const forced = { ...d.deps, checkAgentStatus: true as const };
    const raw2 = Buffer.from(JSON.stringify(imessageEvent("evt_old2", "conv_1")));
    expect(await relayEvent(old, raw2, signHeaders(raw2, old.signingKey), forced)).toMatchObject({ status: "rejected", reason: "agent deploying" });
    const off = { ...d.deps, checkAgentStatus: false as const };
    const young = readyUser({ createdAt: new Date().toISOString() });
    const raw3 = Buffer.from(JSON.stringify(imessageEvent("evt_young2", "conv_1")));
    expect(await relayEvent(young, raw3, signHeaders(raw3, young.signingKey), off)).toEqual({ status: "forwarded" });
  });

  it("treats a 200 with a null response and no error as not delivered", async () => {
    const d = deps();
    const user = readyUser();
    const raw = Buffer.from(JSON.stringify(imessageEvent("evt_null", "conv_1")));
    d.mar.queue.push({ body: { response: null } }, { body: { response: null } }, { body: { response: null } });
    const r = await relayEvent(user, raw, signHeaders(raw, user.signingKey), d.deps);
    expect(r.status).toBe("rejected");
    expect(r.reason).toContain("accepted without a response");
    d.mar.queue.push({ body: { response: null } });
    expect(await relayEvent(user, raw, signHeaders(raw, user.signingKey), d.deps)).toEqual({ status: "forwarded" });
    expect(d.mar.queue).toHaveLength(0);
  });

  it("treats Maritime's own 'couldn't be woken' reply as not delivered, so the inbox retries it", async () => {
    const d = deps();
    const user = readyUser();
    const raw = Buffer.from(JSON.stringify(imessageEvent("evt_wake", "conv_1")));
    const woken = { body: { response: "Your agent couldn't be woken right now. Please try again in a moment." } };
    d.mar.queue.push(woken, woken, woken);
    const r = await relayEvent(user, raw, signHeaders(raw, user.signingKey), d.deps);
    expect(r.status).toBe("rejected");
    expect(r.reason).toContain("couldn't be woken");
    d.mar.queue.push({ body: { response: "" } });
    expect(await relayEvent(user, raw, signHeaders(raw, user.signingKey), d.deps)).toEqual({ status: "forwarded" });
  });
});

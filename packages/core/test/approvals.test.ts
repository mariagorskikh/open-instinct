import { describe, expect, it } from "vitest";
import { ApprovalStore, hasExplicitVerb, parseYesNo } from "../src/approvals.js";
import { tempState } from "./helpers.js";

const base = { conversationKey: "a2a:ctx1", requestedBy: "contact:sam", summary: "Book Nopa Thu 7pm for 2", capability: "plans.commit" as const };

describe("parseYesNo", () => {
  it("reads common replies", () => {
    for (const t of ["yes", "Yes!", "y", "ok", "Okay.", "sure", "approve", "go ahead", "yes please book it"]) expect(parseYesNo(t), t).toBe(true);
    for (const t of ["no", "No.", "n", "nope", "deny", "cancel", "no thanks", "don't"]) expect(parseYesNo(t), t).toBe(false);
    for (const t of ["", "what time?", "maybe later", "yesterday was fun", "notify me"]) expect(parseYesNo(t), t).toBeUndefined();
  });

  it("in strict mode accepts only short plain verdicts made of unambiguous words", () => {
    for (const t of ["yes", "Yes!", "yes please", "y", "approve", "go ahead", "confirm", "do it", "book it"]) expect(parseYesNo(t, { strict: true }), t).toBe(true);
    for (const t of ["no", "No thanks.", "nope", "deny", "decline", "don't", "reject it"]) expect(parseYesNo(t, { strict: true }), t).toBe(false);
    // Casual words answer anything, verbs with objects are instructions, long replies are conversation.
    for (const t of ["ok", "okay", "sure", "yeah", "go", "go to the gym", "cancel my 3pm", "stop", "Yes, and remind me to call mom at 6", "yes please book the later flight", "no I meant Thursday"]) {
      expect(parseYesNo(t, { strict: true }), t).toBeUndefined();
    }
  });

  it("spots explicit approval verbs", () => {
    expect(hasExplicitVerb("approve")).toBe(true);
    expect(hasExplicitVerb("I confirm")).toBe(true);
    expect(hasExplicitVerb("denied")).toBe(true);
    expect(hasExplicitVerb("yes")).toBe(false);
    expect(hasExplicitVerb("sure thing")).toBe(false);
  });
});

describe("ApprovalStore", () => {
  it("creates pending approvals with a short readable token and a ttl", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    const store = new ApprovalStore(tempState(), { now: () => now, ttlMs: 60_000 });
    const a = store.create(base);
    expect(a.token).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    expect(a.status).toBe("pending");
    expect(a.createdAt).toBe(now.toISOString());
    expect(a.expiresAt).toBe(new Date(now.getTime() + 60_000).toISOString());
    expect(store.get(a.token)).toEqual(a);
    expect(store.get(a.token.toLowerCase())).toEqual(a);
    expect(store.pending()).toHaveLength(1);
  });

  it("resolves by token once", () => {
    const store = new ApprovalStore(tempState());
    const a = store.create(base);
    expect(store.resolve(a.token, true)?.status).toBe("approved");
    expect(store.resolve(a.token, false)?.status).toBe("approved"); // already settled, unchanged
    expect(store.pending()).toHaveLength(0);
    expect(store.resolve("ZZZZ", true)).toBeUndefined();
  });

  it("expires with time", () => {
    let now = new Date("2026-10-03T12:00:00Z");
    const store = new ApprovalStore(tempState(), { now: () => now, ttlMs: 1000 });
    const a = store.create(base);
    now = new Date(now.getTime() + 2000);
    expect(store.pending()).toHaveLength(0);
    expect(store.get(a.token)?.status).toBe("expired");
    expect(store.resolve(a.token, true)?.status).toBe("expired");
    expect(store.matchReply("yes")).toBeUndefined();
  });

  it("does not let a bare yes settle someone else's request out of context", () => {
    const store = new ApprovalStore(tempState());
    store.create(base); // requested by contact:sam
    expect(store.matchReply("what is this about?")).toBeUndefined();
    for (const t of ["Yes", "yes", "ok", "sure", "yeah", "go", "y"]) {
      expect(store.matchReply(t), t).toBeUndefined();
    }
    expect(store.pending()).toHaveLength(1);
  });

  it("settles a bare yes when the approval text was the last thing sent to the owner", () => {
    const store = new ApprovalStore(tempState());
    const a = store.create(base);
    store.markPrompted(a.token);
    expect(store.promptedToken()).toBe(a.token);
    expect(store.matchReply("sure")).toBeUndefined(); // casual words still need the token
    const m = store.matchReply("Yes");
    expect(m?.approved).toBe(true);
    expect(m?.approval.token).toBe(a.token);
    expect(m?.approval.status).toBe("approved");
    expect(m?.remainder).toBe("");
    expect(store.promptedToken()).toBeUndefined(); // settled, so the context is gone
    expect(store.matchReply("yes")).toBeUndefined(); // nothing pending any more
  });

  it("drops the context once something else was said to the owner", () => {
    const store = new ApprovalStore(tempState());
    const a = store.create(base);
    store.markPrompted(a.token);
    store.clearPrompted();
    expect(store.matchReply("yes")).toBeUndefined();
    expect(store.pending()).toHaveLength(1);
    expect(store.matchReply(`yes ${a.token}`)?.approved).toBe(true);
  });

  it("accepts an explicit verb without a token, and a bare yes for the owner's own cheap request", () => {
    const store = new ApprovalStore(tempState());
    const a = store.create(base);
    expect(store.matchReply("approve")?.approval.token).toBe(a.token);
    const own = store.create({ ...base, requestedBy: "owner" });
    expect(store.matchReply("yes")?.approval.token).toBe(own.token);
    const money = store.create({ ...base, requestedBy: "owner", amountUsd: 75 });
    expect(store.matchReply("yes")).toBeUndefined(); // money needs the token or the context
    store.markPrompted(money.token);
    expect(store.matchReply("yes")?.approval.token).toBe(money.token);
  });

  it("won't let a bare yes settle the owner's own request once it is stale", () => {
    let now = new Date("2026-10-17T10:00:00Z");
    const store = new ApprovalStore(tempState(), { now: () => now });
    store.create({ ...base, requestedBy: "owner" });
    now = new Date("2026-10-17T10:30:00Z");
    expect(store.matchReply("yes")).toBeUndefined();
    expect(store.pending()).toHaveLength(1);
  });

  it("leaves the approval alone when the owner is talking about something else", () => {
    const store = new ApprovalStore(tempState());
    const a = store.create(base);
    store.markPrompted(a.token);
    for (const t of ["Yes, and remind me to call mom at 6", "cancel my 3pm", "go to the gym", "stop by the store", "no I meant Thursday"]) {
      expect(store.matchReply(t), t).toBeUndefined();
    }
    expect(store.pending()).toHaveLength(1);
  });

  it("returns the leftover text when a token reply carries more than the verdict", () => {
    const store = new ApprovalStore(tempState());
    const a = store.create(base);
    const m = store.matchReply(`Yes ${a.token}, and remind me to call mom at 6`);
    expect(m?.approved).toBe(true);
    expect(m?.remainder).toBe("remind me to call mom at 6");
    const b = store.create(base);
    expect(store.matchReply(`ok ${b.token.toLowerCase()}`)?.remainder).toBe("");
  });

  it("needs the token when several are pending, and accepts it in any case or order", () => {
    const store = new ApprovalStore(tempState());
    const a = store.create(base);
    const b = store.create({ ...base, summary: "Buy flowers $40", capability: "purchase", amountUsd: 40 });
    expect(store.matchReply("yes")).toBeUndefined();
    expect(store.pending()).toHaveLength(2);
    const m1 = store.matchReply(`no ${b.token.toLowerCase()}`);
    expect(m1?.approved).toBe(false);
    expect(m1?.approval.token).toBe(b.token);
    expect(store.get(b.token)?.status).toBe("denied");
    const m2 = store.matchReply(`${a.token} yes please`);
    expect(m2?.approved).toBe(true);
    expect(m2?.approval.token).toBe(a.token);
    expect(store.pending()).toHaveLength(0);
  });

  it("ignores a token with no verdict; an unknown token is just a word", () => {
    const store = new ApprovalStore(tempState());
    const a = store.create(base);
    expect(store.matchReply(a.token)).toBeUndefined();
    expect(store.pending()).toHaveLength(1);
    expect(store.matchReply("yes QQQQ")).toBeUndefined(); // unknown token, no context: not a bare yes either
    store.markPrompted(a.token);
    expect(store.matchReply("yes QQQQ")).toBeUndefined(); // "QQQQ" is not a filler word
    const m = store.matchReply("yes");
    expect(m?.approval.token).toBe(a.token);
    expect(store.pending()).toHaveLength(0);
  });

  it("persists across instances", () => {
    const state = tempState();
    const a = new ApprovalStore(state).create(base);
    const again = new ApprovalStore(state);
    expect(again.get(a.token)?.summary).toBe(base.summary);
  });
});

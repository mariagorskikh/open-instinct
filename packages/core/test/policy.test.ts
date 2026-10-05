import { describe, expect, it } from "vitest";
import {
  ALL_CAPABILITIES,
  DEFAULT_TIER_TABLE,
  PolicyEngine,
  defaultPolicy,
  loadPolicy,
  savePolicy,
} from "../src/policy.js";
import { TIER_ORDER, type Capability, type ToolMeta } from "../src/types.js";
import { principalOf, tempState } from "./helpers.js";

const meta = (caps: Capability[], extra: Partial<ToolMeta> = {}): ToolMeta => ({ capabilities: caps, group: "system", ...extra });
const purchaseMeta: ToolMeta = {
  capabilities: ["purchase"],
  group: "apps",
  amountUsd: (a) => (a as { amountUsd?: number }).amountUsd,
  describe: (a) => `Buy ${(a as { item?: string }).item ?? "something"}`,
};

describe("DEFAULT_TIER_TABLE", () => {
  it("has every capability for every tier", () => {
    for (const tier of TIER_ORDER) {
      for (const cap of ALL_CAPABILITIES) {
        expect(DEFAULT_TIER_TABLE[tier][cap], `${tier}/${cap}`).toBeDefined();
      }
    }
    expect(ALL_CAPABILITIES.length).toBe(26);
  });

  it("matches docs/PERMISSIONS.md on the rows that have special values", () => {
    expect(DEFAULT_TIER_TABLE.stranger.converse).toBe("intro");
    expect(DEFAULT_TIER_TABLE.partner["contacts.read"]).toBe("partial");
    expect(DEFAULT_TIER_TABLE.owner.purchase).toBe("limit");
    expect(DEFAULT_TIER_TABLE.owner["travel.book"]).toBe("limit");
    expect(DEFAULT_TIER_TABLE.partner["calendar.write"]).toBe("ask");
    expect(DEFAULT_TIER_TABLE.family["calendar.write"]).toBe("ask");
    expect(DEFAULT_TIER_TABLE.friend["calendar.write"]).toBe("no");
    expect(DEFAULT_TIER_TABLE.friend["plans.commit"]).toBe("ask");
    expect(DEFAULT_TIER_TABLE.contact["plans.propose"]).toBe("no");
    expect(DEFAULT_TIER_TABLE.stranger["owner.profile.public"]).toBe("no");
    expect(DEFAULT_TIER_TABLE.stranger["owner.relay"]).toBe("yes");
    expect(DEFAULT_TIER_TABLE.partner["email.read"]).toBe("no");
    expect(DEFAULT_TIER_TABLE.partner["email.send"]).toBe("ask");
    expect(DEFAULT_TIER_TABLE.family["owner.location.approx"]).toBe("yes");
    expect(DEFAULT_TIER_TABLE.friend["owner.location.approx"]).toBe("no");
  });

  it("gives only the owner the dangerous capabilities", () => {
    for (const cap of ["computer.use", "files.read", "files.write", "memory.write", "network.invite", "trust.manage", "schedule.manage", "email.read"] as Capability[]) {
      expect(DEFAULT_TIER_TABLE.owner[cap]).toBe("yes");
      for (const tier of TIER_ORDER.filter((t) => t !== "owner")) expect(DEFAULT_TIER_TABLE[tier][cap], `${tier}/${cap}`).toBe("no");
    }
  });
});

describe("PolicyEngine.evaluate across tiers", () => {
  const engine = new PolicyEngine(defaultPolicy());

  it("lets everyone converse, strangers only as an introduction", () => {
    for (const tier of TIER_ORDER) {
      const d = engine.evaluate(principalOf(tier), meta(["converse"]), {});
      expect(d.outcome, tier).toBe("allow");
      if (tier === "stranger") expect(d.reason).toMatch(/introduction/);
    }
  });

  it("gates calendar.freebusy at friend and above", () => {
    const expected: Record<string, string> = { owner: "allow", partner: "allow", family: "allow", friend: "allow", contact: "deny", stranger: "deny" };
    for (const tier of TIER_ORDER) expect(engine.evaluate(principalOf(tier), meta(["calendar.freebusy"]), {}).outcome, tier).toBe(expected[tier]);
  });

  it("gates calendar.write as yes/ask/ask/no/no/no", () => {
    const expected: Record<string, string> = { owner: "allow", partner: "ask", family: "ask", friend: "deny", contact: "deny", stranger: "deny" };
    for (const tier of TIER_ORDER) expect(engine.evaluate(principalOf(tier), meta(["calendar.write"]), {}).outcome, tier).toBe(expected[tier]);
  });

  it("keeps computer.use for the owner only", () => {
    for (const tier of TIER_ORDER) {
      expect(engine.evaluate(principalOf(tier), meta(["computer.use"]), {}).outcome).toBe(tier === "owner" ? "allow" : "deny");
    }
  });

  it("marks partial permissions as allow with a hint", () => {
    const d = engine.evaluate(principalOf("partner"), meta(["contacts.read"]), {});
    expect(d.outcome).toBe("allow");
    expect(d.reason).toMatch(/in part/);
  });

  it("returns an approval prompt that names the asker and ends with YES or NO", () => {
    const d = engine.evaluate(principalOf("partner"), meta(["calendar.write"], { describe: () => "Add dinner Thu 7pm" }), {});
    expect(d.outcome).toBe("ask");
    if (d.outcome !== "ask") return;
    expect(d.approvalPrompt).toContain("partner person");
    expect(d.approvalPrompt).toContain("Add dinner Thu 7pm");
    expect(d.approvalPrompt).toMatch(/YES or NO/);
  });

  it("requires every capability: deny beats ask beats allow", () => {
    const partner = principalOf("partner");
    expect(engine.evaluate(partner, meta(["calendar.write", "computer.use"]), {}).outcome).toBe("deny");
    expect(engine.evaluate(partner, meta(["converse", "calendar.write"]), {}).outcome).toBe("ask");
    expect(engine.evaluate(partner, meta(["converse", "calendar.freebusy"]), {}).outcome).toBe("allow");
    expect(engine.evaluate(partner, meta([]), {}).outcome).toBe("allow");
  });
});

describe("PolicyEngine spend limits (owner, limit permission)", () => {
  const owner = principalOf("owner");

  it("allows small purchases, asks above the threshold and above the per-action cap", () => {
    const engine = new PolicyEngine(defaultPolicy());
    expect(engine.evaluate(owner, purchaseMeta, { amountUsd: 20, item: "lunch" }).outcome).toBe("allow");
    const ask = engine.evaluate(owner, purchaseMeta, { amountUsd: 75, item: "shoes" });
    expect(ask.outcome).toBe("ask");
    if (ask.outcome === "ask") {
      expect(ask.reason).toMatch(/\$75.*above the ask threshold/);
      expect(ask.approvalPrompt).toContain("Buy shoes");
      expect(ask.approvalPrompt).toContain("$75");
    }
    const big = engine.evaluate(owner, purchaseMeta, { amountUsd: 150 });
    expect(big.outcome).toBe("ask");
    if (big.outcome === "ask") expect(big.reason).toMatch(/per-action/);
  });

  it("asks when the daily total would be exceeded", () => {
    const engine = new PolicyEngine(defaultPolicy(), { spentTodayUsd: () => 280 });
    const d = engine.evaluate(owner, purchaseMeta, { amountUsd: 40 });
    expect(d.outcome).toBe("ask");
    if (d.outcome === "ask") expect(d.reason).toMatch(/daily limit/);
    expect(engine.evaluate(owner, purchaseMeta, { amountUsd: 10 }).outcome).toBe("allow");
  });

  it("asks when the amount is unknown", () => {
    const engine = new PolicyEngine(defaultPolicy());
    const d = engine.evaluate(owner, purchaseMeta, { item: "mystery" });
    expect(d.outcome).toBe("ask");
    if (d.outcome === "ask") expect(d.reason).toMatch(/amount unknown/);
  });

  it("always asks for the neverWithoutAsk categories even when cheap", () => {
    const engine = new PolicyEngine(defaultPolicy());
    const d = engine.evaluate(owner, { ...purchaseMeta, capabilities: ["travel.book"] }, { amountUsd: 5, item: "Flights to Boston" });
    expect(d.outcome).toBe("ask");
    if (d.outcome === "ask") expect(d.reason).toMatch(/flights/);
  });

  it("denies blocked merchants and asks for merchants off an allow list", () => {
    const policy = defaultPolicy();
    policy.spend.blockedMerchants = ["casino"];
    policy.spend.allowedMerchants = ["uber", "doordash"];
    const engine = new PolicyEngine(policy);
    expect(engine.evaluate(owner, purchaseMeta, { amountUsd: 10, merchant: "Lucky Casino" }).outcome).toBe("deny");
    // Blocked merchants are blocked for everyone, including tiers that would otherwise ask.
    expect(engine.evaluate(principalOf("partner"), purchaseMeta, { amountUsd: 10, merchant: "Lucky Casino" }).outcome).toBe("deny");
    expect(engine.evaluate(principalOf("partner"), purchaseMeta, { amountUsd: 10, merchant: "Uber" }).outcome).toBe("ask");
    expect(engine.evaluate(owner, purchaseMeta, { amountUsd: 10, merchant: "Uber" }).outcome).toBe("allow");
    expect(engine.evaluate(owner, purchaseMeta, { amountUsd: 10, merchant: "Amazon" }).outcome).toBe("ask");
    // payment_request names the merchant merchantName; the lists must still apply.
    expect(engine.evaluate(owner, purchaseMeta, { amountUsd: 10, merchantName: "Lucky Casino" }).outcome).toBe("deny");
    expect(engine.evaluate(owner, purchaseMeta, { amountUsd: 10, merchantName: "Uber" }).outcome).toBe("allow");
    // Every merchant field counts: an allowed `merchant` cannot cover a blocked or unlisted `merchantName`.
    expect(engine.evaluate(owner, purchaseMeta, { amountUsd: 10, merchant: "Uber", merchantName: "Lucky Casino" }).outcome).toBe("deny");
    expect(engine.evaluate(owner, purchaseMeta, { amountUsd: 10, merchant: "Uber", merchantName: "Amazon" }).outcome).toBe("ask");
  });
});

describe("PolicyEngine grants", () => {
  const now = new Date("2026-10-07T15:00:00Z");
  const friend = principalOf("friend", { id: "contact:sam", contactId: "sam", displayName: "Sam" });

  it("upgrades a no to allow and reports the grant id", () => {
    const engine = new PolicyEngine(defaultPolicy(), { now: () => now });
    expect(engine.evaluate(friend, meta(["calendar.write"]), {}).outcome).toBe("deny");
    const g = engine.addGrant({ to: "contact:sam", capabilities: ["calendar.write"], note: "dinner this week" });
    expect(g.id).toMatch(/^g_/);
    expect(g.createdAt).toBe(now.toISOString());
    const d = engine.evaluate(friend, meta(["calendar.write"]), {});
    expect(d.outcome).toBe("allow");
    if (d.outcome === "allow") expect(d.viaGrant).toBe(g.id);
    expect(engine.toJSON().grants).toHaveLength(1);
  });

  it("applies grants addressed to the contact when an agent acts for them", () => {
    const engine = new PolicyEngine(defaultPolicy(), { now: () => now });
    engine.addGrant({ to: "contact:sam", capabilities: ["plans.commit"] });
    const agent = principalOf("friend", { kind: "agent", id: "agent:sam-bot", agentHandle: "sam-bot", contactId: "sam", displayName: "Sam's agent" });
    expect(engine.evaluate(agent, meta(["plans.commit"]), {}).outcome).toBe("allow");
    const other = principalOf("friend", { id: "contact:alex", contactId: "alex" });
    expect(engine.evaluate(other, meta(["plans.commit"]), {}).outcome).toBe("ask");
  });

  it("respects maxUsd: within cap allows, over cap falls back to the tier default", () => {
    const engine = new PolicyEngine(defaultPolicy(), { now: () => now });
    const g = engine.addGrant({ to: "contact:sam", capabilities: ["purchase"], scope: { maxUsd: 150 } });
    const ok = engine.evaluate(friend, purchaseMeta, { amountUsd: 100 });
    expect(ok.outcome).toBe("allow");
    if (ok.outcome === "allow") expect(ok.viaGrant).toBe(g.id);
    expect(engine.evaluate(friend, purchaseMeta, { amountUsd: 200 }).outcome).toBe("deny");
    const partner = principalOf("partner", { id: "contact:sam", contactId: "sam" });
    const d = engine.evaluate(partner, purchaseMeta, { amountUsd: 200 });
    expect(d.outcome).toBe("ask");
    if (d.outcome === "ask") expect(d.reason).toMatch(/exceeds grant/);
  });

  it("keeps the spend policy in force under a spend grant", () => {
    const policy = defaultPolicy();
    policy.spend.blockedMerchants = ["casino"];
    const engine = new PolicyEngine(policy, { now: () => now, spentTodayUsd: () => 250 });
    engine.addGrant({ to: "contact:sam", capabilities: ["purchase", "travel.book"], scope: { maxUsd: 150 } });

    // Blocked merchants stay blocked, even for a grantee.
    expect(engine.evaluate(friend, purchaseMeta, { amountUsd: 20, merchant: "Lucky Casino" }).outcome).toBe("deny");
    // Flights and hotels always ask.
    const flights = engine.evaluate(friend, { ...purchaseMeta, capabilities: ["travel.book"] }, { amountUsd: 90, item: "flights to Lisbon" });
    expect(flights.outcome).toBe("ask");
    if (flights.outcome === "ask") {
      expect(flights.reason).toMatch(/flights/);
      expect(flights.approvalPrompt).toContain("Sam asks");
    }
    // An unknown amount is never a free pass.
    const unknown = engine.evaluate(friend, purchaseMeta, { item: "mystery" });
    expect(unknown.outcome).toBe("ask");
    if (unknown.outcome === "ask") expect(unknown.reason).toMatch(/amount unknown/);
    // The daily total still counts.
    const daily = engine.evaluate(friend, purchaseMeta, { amountUsd: 80, item: "dinner" });
    expect(daily.outcome).toBe("ask");
    if (daily.outcome === "ask") expect(daily.reason).toMatch(/daily limit/);
    // Over the owner's per-action limit asks even when under the grant cap.
    const big = new PolicyEngine(policy, { now: () => now });
    expect(big.addGrant({ to: "contact:sam", capabilities: ["purchase"], scope: { maxUsd: 500 } }).id).toMatch(/^g_/);
    const perAction = big.evaluate(friend, purchaseMeta, { amountUsd: 120, item: "speaker" });
    expect(perAction.outcome).toBe("ask");
    if (perAction.outcome === "ask") expect(perAction.reason).toMatch(/per-action/);
    // Inside every limit: allowed, and attributed to the grant.
    const fine = new PolicyEngine(policy, { now: () => now, spentTodayUsd: () => 10 });
    const g = fine.addGrant({ to: "contact:sam", capabilities: ["purchase"], scope: { maxUsd: 150 } });
    const d = fine.evaluate(friend, purchaseMeta, { amountUsd: 80, item: "dinner", merchant: "Nopa" });
    expect(d.outcome).toBe("allow");
    if (d.outcome === "allow") expect(d.viaGrant).toBe(g.id);
    // A grant without a cap uses the owner's own ask threshold.
    const uncapped = new PolicyEngine(policy, { now: () => now });
    uncapped.addGrant({ to: "contact:sam", capabilities: ["purchase"] });
    expect(uncapped.evaluate(friend, purchaseMeta, { amountUsd: 20, item: "coffee" }).outcome).toBe("allow");
    expect(uncapped.evaluate(friend, purchaseMeta, { amountUsd: 75, item: "shoes" }).outcome).toBe("ask");
  });

  it("ignores expired grants and grants outside their window", () => {
    const engine = new PolicyEngine(defaultPolicy(), { now: () => now });
    engine.addGrant({ to: "contact:sam", capabilities: ["calendar.write"], expiresAt: "2026-10-01T00:00:00Z" });
    engine.addGrant({ to: "contact:sam", capabilities: ["calendar.read"], scope: { window: { from: "2026-10-20", to: "2026-10-25" } } });
    engine.addGrant({ to: "contact:sam", capabilities: ["email.send"], scope: { window: { from: "2026-10-01", to: "2026-10-07" } } });
    expect(engine.evaluate(friend, meta(["calendar.write"]), {}).outcome).toBe("deny");
    expect(engine.evaluate(friend, meta(["calendar.read"]), {}).outcome).toBe("deny");
    // The window's last day is inclusive.
    expect(engine.evaluate(friend, meta(["email.send"]), {}).outcome).toBe("allow");
    expect(engine.listGrants("contact:sam").map((g) => g.capabilities[0])).toEqual(["email.send"]);
  });

  it("expires with time", () => {
    let t = new Date("2026-10-07T15:00:00Z");
    const engine = new PolicyEngine(defaultPolicy(), { now: () => t });
    engine.addGrant({ to: "contact:sam", capabilities: ["calendar.write"], expiresAt: "2026-10-08T00:00:00Z" });
    expect(engine.evaluate(friend, meta(["calendar.write"]), {}).outcome).toBe("allow");
    t = new Date("2026-10-08T00:00:01Z");
    expect(engine.evaluate(friend, meta(["calendar.write"]), {}).outcome).toBe("deny");
    expect(engine.canEver(friend, "calendar.write")).toBe(false);
  });

  it("revokes", () => {
    const engine = new PolicyEngine(defaultPolicy(), { now: () => now });
    const g = engine.addGrant({ to: "contact:sam", capabilities: ["calendar.write"] });
    expect(engine.revokeGrant(g.id)).toBe(true);
    expect(engine.revokeGrant(g.id)).toBe(false);
    expect(engine.evaluate(friend, meta(["calendar.write"]), {}).outcome).toBe("deny");
  });
});

describe("PolicyEngine.canEver and overrides", () => {
  it("hides tools whose capability is a hard no without a grant", () => {
    const engine = new PolicyEngine(defaultPolicy());
    const friend = principalOf("friend", { id: "contact:sam", contactId: "sam" });
    expect(engine.canEver(friend, "computer.use")).toBe(false);
    expect(engine.canEver(friend, "plans.commit")).toBe(true); // ask is not no
    expect(engine.canEver(principalOf("stranger"), "converse")).toBe(true);
    expect(engine.canEver(principalOf("owner"), "purchase")).toBe(true);
    engine.addGrant({ to: "contact:sam", capabilities: ["computer.use"] });
    expect(engine.canEver(friend, "computer.use")).toBe(true);
  });

  it("applies tier overrides and drops ones equal to the default", () => {
    const engine = new PolicyEngine(defaultPolicy());
    const friend = principalOf("friend");
    engine.setTierOverride("friend", "calendar.read", "yes");
    expect(engine.evaluate(friend, meta(["calendar.read"]), {}).outcome).toBe("allow");
    expect(engine.toJSON().tiers.friend?.["calendar.read"]).toBe("yes");
    engine.setTierOverride("friend", "calendar.read", "no");
    expect(engine.toJSON().tiers.friend).toBeUndefined();
    expect(engine.evaluate(friend, meta(["calendar.read"]), {}).outcome).toBe("deny");
  });

  it("does not mutate the policy object it was given", () => {
    const policy = defaultPolicy();
    const engine = new PolicyEngine(policy);
    engine.addGrant({ to: "contact:x", capabilities: ["converse"] });
    expect(policy.grants).toHaveLength(0);
  });
});

describe("loadPolicy / savePolicy", () => {
  it("round-trips and fills defaults for a partial file", () => {
    const state = tempState();
    expect(loadPolicy(state)).toEqual(defaultPolicy());
    const engine = new PolicyEngine(defaultPolicy());
    engine.addGrant({ to: "contact:sam", capabilities: ["calendar.write"] });
    engine.setTierOverride("friend", "calendar.read", "yes");
    savePolicy(state, engine.toJSON());
    const loaded = loadPolicy(state);
    expect(loaded.grants).toHaveLength(1);
    expect(loaded.tiers.friend?.["calendar.read"]).toBe("yes");
    state.writeJson("policy.json", { version: 1, spend: { askAbove: 10 } });
    const partial = loadPolicy(state);
    expect(partial.spend.askAbove).toBe(10);
    expect(partial.spend.perDayUsd).toBe(300);
    expect(partial.grants).toEqual([]);
    expect(partial.strangerLimits.conversationsPerDay).toBe(3);
  });
});

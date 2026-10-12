import { describe, expect, it } from "vitest";
import { ContactStore } from "../src/contacts.js";
import { OWNER_EMAIL_PRINCIPAL_ID, OWNER_EMAIL_TIER, capTier, isReservedHandle, normalizeHandle, normalizePhone, resolvePrincipal } from "../src/principal.js";
import { TIER_ORDER } from "../src/types.js";
import { inbound, tempState, testConfig } from "./helpers.js";

describe("normalizePhone", () => {
  it("keeps digits, prefixes +, assumes US for ten digits", () => {
    expect(normalizePhone("(617) 555-0100")).toBe("+16175550100");
    expect(normalizePhone("617.555.0100")).toBe("+16175550100");
    expect(normalizePhone("+1 617 555 0100")).toBe("+16175550100");
    expect(normalizePhone("1-617-555-0100")).toBe("+16175550100");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone("abc")).toBe("");
  });
});

describe("normalizeHandle", () => {
  it("strips @ and lowercases", () => {
    expect(normalizeHandle("@Maria-Instinct")).toBe("maria-instinct");
    expect(normalizeHandle("  sam_bot ")).toBe("sam_bot");
    expect(normalizeHandle("@@x")).toBe("x");
  });
});

describe("resolvePrincipal", () => {
  const config = testConfig();

  function contacts(): ContactStore {
    const store = new ContactStore(tempState());
    store.upsert({ name: "Sam Lee", tier: "partner", phones: ["(415) 555-0199"], emails: ["Sam@Example.com"], agentHandle: "@Sam-Instinct" });
    store.upsert({ name: "Alex Kim", tier: "friend", emails: ["alex@example.com"] });
    return store;
  }

  it("recognises the owner by phone in any formatting and on local channels", () => {
    const c = contacts();
    for (const from of ["+16175550100", "(617) 555-0100", "617-555-0100", "16175550100"]) {
      const p = resolvePrincipal(inbound({ channel: "imessage", from }), config, c);
      expect(p.kind, from).toBe("owner");
      expect(p.id).toBe("owner");
      expect(p.tier).toBe("owner");
      expect(p.displayName).toBe("Maria");
      expect(p.phone).toBe("+16175550100");
    }
    expect(resolvePrincipal(inbound({ channel: "whatsapp", from: "+16175550100" }), config, c).kind).toBe("owner");
    for (const channel of ["chat", "scheduled", "system"] as const) {
      expect(resolvePrincipal(inbound({ channel, from: "anything" }), config, c).kind).toBe("owner");
    }
  });

  it("reduces the owner's own email address to a partner-tier contact, because From can be forged", () => {
    const c = contacts();
    const p = resolvePrincipal(inbound({ channel: "email", from: "MARIA@example.com" }), config, c);
    expect(p.kind).toBe("contact");
    expect(p.id).toBe(OWNER_EMAIL_PRINCIPAL_ID);
    expect(p.tier).toBe("partner");
    expect(p.email).toBe("maria@example.com");
    expect(p.displayName).toContain("Maria");
    expect(p.displayName).toMatch(/unverified/);
  });

  it("never honours the literal sender \"owner\" on a network channel", () => {
    const c = contacts();
    const im = resolvePrincipal(inbound({ channel: "imessage", from: "owner" }), config, c);
    expect(im.kind).toBe("stranger");
    expect(im.tier).toBe("stranger");
    const a2a = resolvePrincipal(inbound({ channel: "a2a", from: "owner" }), config, c);
    expect(a2a).toMatchObject({ kind: "stranger", tier: "stranger", id: "stranger:a2a:owner", agentHandle: "owner" });
    expect(resolvePrincipal(inbound({ channel: "a2a", from: "@Owner" }), config, c).kind).toBe("stranger");
    expect(resolvePrincipal(inbound({ channel: "email", from: "owner" }), config, c).kind).toBe("stranger");
    expect(isReservedHandle("@OWNER")).toBe(true);
    expect(isReservedHandle("sam-instinct")).toBe(false);
  });

  it("resolves contacts by phone and email with their tier", () => {
    const c = contacts();
    const byPhone = resolvePrincipal(inbound({ channel: "sms", from: "415-555-0199" }), config, c);
    expect(byPhone).toMatchObject({ kind: "contact", id: "contact:sam-lee", tier: "partner", displayName: "Sam Lee", contactId: "sam-lee", phone: "+14155550199", agentHandle: "sam-instinct" });
    const byEmail = resolvePrincipal(inbound({ channel: "email", from: "ALEX@example.com" }), config, c);
    expect(byEmail).toMatchObject({ kind: "contact", id: "contact:alex-kim", tier: "friend", email: "alex@example.com" });
  });

  it("maps an A2A caller handle to the contact's agent", () => {
    const c = contacts();
    const p = resolvePrincipal(inbound({ channel: "a2a", from: "@Sam-Instinct" }), config, c);
    expect(p.kind).toBe("agent");
    expect(p.id).toBe("agent:sam-instinct");
    expect(p.tier).toBe("partner");
    expect(p.agentHandle).toBe("sam-instinct");
    expect(p.contactId).toBe("sam-lee");
    expect(p.onBehalfOf).toEqual({ displayName: "Sam Lee", contactId: "sam-lee" });
  });

  it("treats everyone else as a stranger with a channel-scoped id", () => {
    const c = contacts();
    const sms = resolvePrincipal(inbound({ channel: "imessage", from: "(212) 555-0000" }), config, c);
    expect(sms).toMatchObject({ kind: "stranger", tier: "stranger", id: "stranger:imessage:+12125550000", phone: "+12125550000" });
    const mail = resolvePrincipal(inbound({ channel: "email", from: "Nobody@Nowhere.org" }), config, c);
    expect(mail).toMatchObject({ kind: "stranger", id: "stranger:email:nobody@nowhere.org", email: "nobody@nowhere.org" });
    const a2a = resolvePrincipal(inbound({ channel: "a2a", from: "unknown-bot" }), config, c);
    expect(a2a).toMatchObject({ kind: "stranger", tier: "stranger", id: "stranger:a2a:unknown-bot", agentHandle: "unknown-bot" });
    expect(a2a.contactId).toBeUndefined();
  });

  it("never promotes a contact to owner through a shared-looking address", () => {
    const c = contacts();
    c.upsert({ name: "Impostor", tier: "stranger", phones: ["+16175550101"] });
    const p = resolvePrincipal(inbound({ channel: "imessage", from: "+16175550101" }), config, c);
    expect(p.kind).toBe("contact");
    expect(p.tier).toBe("stranger");
  });
});

describe("resolvePrincipal caps on unauthenticated channels", () => {
  const config = testConfig();

  function withStaff(): ContactStore {
    const store = new ContactStore(tempState());
    store.upsert({ name: "Research", tier: "staff", phones: ["+14155550123"], emails: ["research@team.example"], agentHandle: "research-bot" });
    return store;
  }

  it("never gives an email sender more than partner, so a forged From of a staff contact gets partner", () => {
    const c = withStaff();
    const p = resolvePrincipal(inbound({ channel: "email", from: "Research@Team.example" }), config, c);
    expect(p.kind).toBe("contact");
    expect(p.contactId).toBe("research");
    expect(p.tier).toBe(OWNER_EMAIL_TIER);
    expect(p.tier).toBe("partner");
  });

  it("caps an email-looking sender on another channel too, and a bare handle on the email channel", () => {
    const c = withStaff();
    expect(resolvePrincipal(inbound({ channel: "sms", from: "research@team.example" }), config, c).tier).toBe("partner");
    const handle = resolvePrincipal(inbound({ channel: "email", from: "research-bot" }), config, c);
    expect(handle.contactId).toBe("research");
    expect(handle.tier).toBe("partner");
  });

  it("gives staff only to the contact's agent over A2A; the same contact by phone is partner", () => {
    const c = withStaff();
    const agent = resolvePrincipal(inbound({ channel: "a2a", from: "@research-bot" }), config, c);
    expect(agent).toMatchObject({ kind: "agent", tier: "staff", agentHandle: "research-bot" });
    const phone = resolvePrincipal(inbound({ channel: "sms", from: "+14155550123" }), config, c);
    expect(phone).toMatchObject({ kind: "contact", contactId: "research", tier: "partner" });
  });

  it("never raises a tier: lower-tier email senders keep their tier", () => {
    const c = withStaff();
    c.upsert({ name: "Alex Kim", tier: "friend", emails: ["alex@example.com"] });
    expect(resolvePrincipal(inbound({ channel: "email", from: "alex@example.com" }), config, c).tier).toBe("friend");
    for (const tier of TIER_ORDER) {
      const capped = capTier({ kind: "contact", id: "x", tier, displayName: "x" }, "partner");
      expect(TIER_ORDER.indexOf(capped.tier), tier).toBe(Math.max(TIER_ORDER.indexOf(tier), TIER_ORDER.indexOf("partner")));
    }
  });
});

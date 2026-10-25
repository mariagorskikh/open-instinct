import { beforeEach, describe, expect, it } from "vitest";
import type { Contact } from "@open-instinct/core";
import { A2AStore, StateDir } from "@open-instinct/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkTools } from "../src/tools.js";
import { agentPrincipal, config, contactPrincipal, ctx, fakeA2a, fakeAudit, fakeContacts, fakeOutbox, fakePolicy, fakeProvisioner, owner, run, stranger } from "./fakes.js";

function setup(opts: { a2a?: boolean; provisioner?: boolean; handle?: boolean; a2aStore?: A2AStore; reservedNames?: string[]; meetingWith?: (name: string) => string | undefined; meetingStartWith?: (name: string) => string | undefined; clashWith?: (text: string, peer: string) => string | undefined } = {}) {
  const contacts = fakeContacts([
    { name: "Sam Lee", tier: "partner", phones: ["(617) 555-0101"], emails: ["sam@example.com"], agentHandle: "sam-instinct" },
    { name: "Alex Kim", tier: "friend", phones: ["+16175550102"] },
    { name: "Priya Patel", tier: "contact", emails: ["priya@example.com"] },
    { name: "Nobody Reachable", tier: "friend" },
  ]);
  const policy = fakePolicy();
  const audit = fakeAudit();
  const a2a = fakeA2a();
  const outbox = fakeOutbox();
  const provisioner = fakeProvisioner();
  const changes: unknown[] = [];
  const cfg = config(opts.handle === false ? { agent: { name: "Maria's Instinct" } } : {});
  const tools = networkTools({
    contacts,
    policy,
    config: cfg,
    audit,
    outbox,
    a2a: opts.a2a === false ? undefined : a2a,
    ...(opts.a2aStore ? { a2aStore: opts.a2aStore } : {}),
    provisioner: opts.provisioner ? provisioner : undefined,
    onPolicyChange: (p) => changes.push(p),
    ...(opts.reservedNames ? { reservedNames: opts.reservedNames } : {}),
    ...(opts.meetingWith ? { meetingWith: opts.meetingWith } : {}),
    ...(opts.meetingStartWith ? { meetingStartWith: opts.meetingStartWith } : {}),
    ...(opts.clashWith ? { clashWith: opts.clashWith } : {}),
  });
  const sam = contacts.get("sam-lee") as Contact;
  const alex = contacts.get("alex-kim") as Contact;
  return { tools, contacts, policy, audit, a2a, outbox, provisioner, changes, sam, alex };
}

describe("networkTools registry", () => {
  it("exposes the contracted tools with the right capabilities", () => {
    const { tools } = setup();
    const caps = Object.fromEntries(tools.map((t) => [t.spec.name, t.spec.meta.capabilities]));
    expect(caps).toEqual({
      contacts_search: ["contacts.read"],
      contacts_upsert: ["trust.manage"],
      trust_set_tier: ["trust.manage"],
      trust_grant: ["trust.manage"],
      trust_revoke: ["trust.manage"],
      trust_list: ["trust.manage"],
      ask_instinct: ["network.ask"],
      reply_instinct: ["converse"],
      invite_to_network: ["network.invite"],
    });
    for (const t of tools) expect(t.spec.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe("contacts_search", () => {
  it("gives the owner full records", async () => {
    const { tools } = setup();
    const r = await run(tools, "contacts_search", { query: "sam" }, ctx(owner));
    expect(r.isError).toBe(false);
    expect(r.text).toContain("sam-lee: Sam Lee");
    expect(r.text).toContain("+16175550101");
    expect(r.text).toContain("@sam-instinct");
  });

  it("lists everyone on an empty query", async () => {
    const { tools } = setup();
    const r = await run(tools, "contacts_search", { query: "" }, ctx(owner));
    expect(r.text.split("\n")).toHaveLength(4);
  });

  it("shows a non-owner only their own name and tier", async () => {
    const { tools, sam, alex } = setup();
    const r = await run(tools, "contacts_search", { query: "alex" }, ctx(contactPrincipal(sam)));
    expect(r.text).toBe("Sam Lee (tier partner)");
    expect(r.text).not.toContain(alex.name);
    expect(r.text).not.toContain("+1617");
  });

  it("tells a stranger nothing", async () => {
    const { tools } = setup();
    const r = await run(tools, "contacts_search", { query: "sam" }, ctx(stranger));
    expect(r.text).toBe("You are not in the owner's contacts.");
  });
});

describe("contacts_upsert", () => {
  it("refuses non-owners", async () => {
    const { tools, sam } = setup();
    const r = await run(tools, "contacts_upsert", { name: "Eve" }, ctx(contactPrincipal(sam)));
    expect(r.isError).toBe(true);
  });

  it("merges new phones and handle into an existing contact", async () => {
    const { tools, contacts } = setup();
    const r = await run(tools, "contacts_upsert", { name: "Alex Kim", phone: "617-555-0199", agentHandle: "@Alex-Instinct", notes: "climbing" }, ctx(owner));
    expect(r.text).toMatch(/^Updated/);
    const alex = contacts.get("alex-kim");
    expect(alex?.phones).toEqual(["+16175550102", "+16175550199"]);
    expect(alex?.agentHandle).toBe("alex-instinct");
    expect(alex?.tier).toBe("friend");
  });

  it("creates a new contact and rejects tier owner", async () => {
    const { tools, contacts } = setup();
    const bad = await run(tools, "contacts_upsert", { name: "Eve", tier: "owner" }, ctx(owner));
    expect(bad.isError).toBe(true);
    const ok = await run(tools, "contacts_upsert", { name: "Eve Adams", email: "Eve@Example.com", tier: "friend" }, ctx(owner));
    expect(ok.text).toMatch(/^Added/);
    expect(contacts.get("eve-adams")?.emails).toEqual(["eve@example.com"]);
  });
});

describe("trust_set_tier", () => {
  it("refuses non-owners and the owner tier", async () => {
    const { tools, sam } = setup();
    expect((await run(tools, "trust_set_tier", { contact: "alex", tier: "family" }, ctx(contactPrincipal(sam)))).isError).toBe(true);
    expect((await run(tools, "trust_set_tier", { contact: "alex", tier: "owner" }, ctx(owner))).isError).toBe(true);
  });

  it("moves a contact found by name, phone, email or handle and audits it", async () => {
    const { tools, contacts, audit } = setup();
    const r = await run(tools, "trust_set_tier", { contact: "@sam-instinct", tier: "family" }, ctx(owner));
    expect(r.text).toBe("Sam Lee is now family (was partner).");
    expect(contacts.get("sam-lee")?.tier).toBe("family");
    expect((await run(tools, "trust_set_tier", { contact: "617 555 0102", tier: "family" }, ctx(owner))).text).toContain("Alex Kim is now family");
    expect((await run(tools, "trust_set_tier", { contact: "priya@example.com", tier: "friend" }, ctx(owner))).text).toContain("Priya Patel is now friend");
    expect(audit.entries.filter((e) => e.kind === "policy" && e.detail.action === "set_tier")).toHaveLength(3);
  });

  it("fails clearly on an unknown contact", async () => {
    const { tools } = setup();
    const r = await run(tools, "trust_set_tier", { contact: "zed", tier: "friend" }, ctx(owner));
    expect(r.isError).toBe(true);
    expect(r.text).toContain('No contact matches "zed"');
  });
});

describe("trust_grant / trust_revoke / trust_list", () => {
  it("validates capability names", async () => {
    const { tools, policy } = setup();
    const r = await run(tools, "trust_grant", { to: "sam", capabilities: ["calendar.write", "root"] }, ctx(owner));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Unknown capabilities: root");
    expect(policy.grants).toHaveLength(0);
  });

  it("creates a scoped grant addressed to the contact principal and notifies the host", async () => {
    const { tools, policy, changes, audit } = setup();
    const r = await run(
      tools,
      "trust_grant",
      { to: "Sam Lee", capabilities: ["calendar.write", "plans.commit", "calendar.write"], purpose: "dinner", from: "2026-10-06", to_date: "2026-10-12", maxUsd: 150, note: "Sam can book us dinner this week" },
      ctx(owner),
    );
    expect(r.isError).toBe(false);
    expect(policy.grants).toHaveLength(1);
    const g = policy.grants[0]!;
    expect(g.to).toBe("contact:sam-lee");
    expect(g.capabilities).toEqual(["calendar.write", "plans.commit"]);
    // Plain days are the owner's days (America/New_York in the test config), not UTC ones.
    expect(g.scope).toEqual({ purpose: "dinner", window: { from: "2026-10-06T00:00:00-04:00", to: "2026-10-12T23:59:59-04:00" }, maxUsd: 150 });
    expect(g.expiresAt).toBe("2026-10-12T23:59:59-04:00");
    expect(changes).toHaveLength(1);
    expect(audit.entries.some((e) => e.detail.action === "grant" && e.detail.grantId === g.id)).toBe(true);
    expect(r.details).toEqual({ grantId: g.id });
  });

  it("accepts a raw principal id and rejects a half window", async () => {
    const { tools, policy } = setup();
    expect((await run(tools, "trust_grant", { to: "agent:sam-instinct", capabilities: ["calendar.freebusy"] }, ctx(owner))).isError).toBe(false);
    expect(policy.grants[0]?.to).toBe("agent:sam-instinct");
    expect((await run(tools, "trust_grant", { to: "sam", capabilities: ["calendar.freebusy"], from: "2026-10-06" }, ctx(owner))).isError).toBe(true);
  });

  it("refuses grants from anyone but the owner, even a partner", async () => {
    const { tools, sam, policy } = setup();
    const r = await run(tools, "trust_grant", { to: "contact:sam-lee", capabilities: ["purchase"] }, ctx(contactPrincipal(sam)));
    expect(r.isError).toBe(true);
    expect(policy.grants).toHaveLength(0);
  });

  it("revokes by id and reports unknown ids", async () => {
    const { tools, policy, changes } = setup();
    await run(tools, "trust_grant", { to: "sam", capabilities: ["calendar.read"] }, ctx(owner));
    const id = policy.grants[0]!.id;
    expect((await run(tools, "trust_revoke", { grantId: "nope" }, ctx(owner))).isError).toBe(true);
    expect((await run(tools, "trust_revoke", { grantId: id }, ctx(owner))).text).toBe(`Revoked grant ${id}.`);
    expect(policy.grants).toHaveLength(0);
    expect(changes).toHaveLength(2);
  });

  it("lists tiers, overrides and grants for the owner only", async () => {
    const { tools, policy, sam } = setup();
    await run(tools, "trust_grant", { to: "sam", capabilities: ["calendar.write"], purpose: "dinner" }, ctx(owner));
    policy.setTierOverride("family", "calendar.read", "yes");
    expect((await run(tools, "trust_list", {}, ctx(agentPrincipal(sam)))).isError).toBe(true);
    const r = await run(tools, "trust_list", {}, ctx(owner));
    expect(r.text).toContain("partner: Sam Lee (@sam-instinct)");
    expect(r.text).toContain("friend: Alex Kim, Nobody Reachable");
    expect(r.text).toContain("family calendar.read = yes");
    expect(r.text).toContain("contact:sam-lee -> calendar.write | purpose dinner");
  });
});

describe("ask_instinct", () => {
  it("refuses nested delegation from a worker task instead of orphaning the child result", async () => {
    const { tools, a2a, sam } = setup();
    const result = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Please check" }, ctx(agentPrincipal(sam), { channel: "a2a", replyRef: { taskId: "parent-task" } }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain("ask_caller");
    expect(a2a.calls).toHaveLength(0);
  });

  it("sends nothing for a meeting already set unless asked to move it", async () => {
    const { tools, a2a } = setup({ meetingWith: (n) => (n === "Sam Lee" ? "Sat, Oct 17, 12:30 PM, lobby cafe" : undefined) });
    const held = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Meet up?" }, ctx(owner));
    expect(held.isError).toBe(true);
    expect(held.text).toContain("already meeting Sam Lee: Sat, Oct 17, 12:30 PM, lobby cafe");
    expect(a2a.calls).toHaveLength(0);
    // A question about something else still goes through.
    const other = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Could Sam send the slides from the talk?" }, ctx(owner));
    expect(other.isError).toBe(false);
    expect(a2a.calls).toHaveLength(1);
    const moved = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Move to 4?", move: true }, ctx(owner));
    expect(moved.isError).toBe(false);
    expect(a2a.calls).toHaveLength(2);
    // A note about the meeting is not a new booking.
    const late = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Running 10 minutes late to our meetup" }, ctx(owner));
    expect(late.isError).toBe(false);
    const q = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Before we meet: what is Sam working on these days?" }, ctx(owner));
    expect(q.isError).toBe(false);
    // An "email" with no address in it is not sent.
    const placeholder = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Here's my email for after the meetup" }, ctx(owner));
    expect(placeholder.isError).toBe(true);
    // A 3-way plan is a new meeting, even with someone already met one-to-one.
    const group = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "3-way coffee with Grace at 4:00 PM outside the lobby cafe?" }, ctx(owner));
    expect(group.isError).toBe(false);
    expect(a2a.calls).toHaveLength(5);
  });

  it("won't send a yes or a proposal for a time the owner already gave someone else", async () => {
    const clashWith = (text: string, peer: string) => (/1:30/.test(text) && peer !== "Leo Martins" ? "Leo Martins at Sat, Oct 17, 1:30 PM" : undefined);
    const { tools, a2a } = setup({ clashWith });
    const yes = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Yes, Saturday at 1:30 PM in the lobby cafe works" }, ctx(owner));
    expect(yes.isError).toBe(true);
    expect(yes.text).toContain("already meets Leo Martins");
    const counter = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "1:30 PM is taken; could we meet at 2:00 PM instead?" }, ctx(owner));
    expect(counter.isError).toBe(false);
    const group = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "3-way coffee with Leo at 1:30 PM in the Foyer?" }, ctx(owner));
    expect(group.isError).toBe(false);
    expect(a2a.calls).toHaveLength(2);
  });

  it("insists a new meeting ask names one concrete time, and creates a contact from a bare handle", async () => {
    const { tools, a2a, contacts } = setup();
    const vague = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Meet up on Saturday?" }, ctx(owner));
    expect(vague.isError).toBe(true);
    expect(vague.text).toContain("one concrete time and place");
    expect(a2a.calls).toHaveLength(0);
    const concrete = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Meet Saturday October 17 at 12:30 PM, lunch in the lobby cafe?" }, ctx(owner));
    expect(concrete.isError).toBe(false);
    expect(a2a.calls).toHaveLength(1);
    const byHandle = await run(tools, "ask_instinct", { contact: "@priya-natarajan-wjzg2", intent: "ask", text: "Could Priya send the slides?" }, ctx(owner));
    expect(byHandle.isError).toBe(false);
    expect(a2a.calls).toHaveLength(2);
    expect(contacts.all().find((c) => c.agentHandle === "@priya-natarajan-wjzg2")?.name).toBe("Priya Natarajan");
    const { nameFromHandle } = await import("../src/tools.js");
    expect(nameFromHandle("@tom-okafor-9x2kq")).toBe("Tom Okafor");
    expect(nameFromHandle("ida-55f6v")).toBe("Ida");
    expect(nameFromHandle("maria-instinct")).toBe("Maria Instinct");
  });

  it("refuses a move to the time already held", async () => {
    const { tools, a2a } = setup({ meetingWith: () => "Sat, Oct 17, 4:00 PM", meetingStartWith: () => "2026-10-17T23:00:00.000Z" });
    const same = await run(tools, "ask_instinct", { contact: "sam", intent: "propose_times", text: "Move to 4?", move: true, payload: { slots: [{ start: "2026-10-17T16:00:00-07:00" }] } }, ctx(owner));
    expect(same.isError).toBe(true);
    expect(same.text).toContain("already at that time");
    const other = await run(tools, "ask_instinct", { contact: "sam", intent: "propose_times", text: "Move to 12:30?", move: true, payload: { slots: [{ start: "2026-10-17T12:30:00-07:00" }] } }, ctx(owner));
    expect(other.isError).toBe(false);
    expect(a2a.calls).toHaveLength(1);
  });

  it("refuses a contact saved under another name that carries a staff handle", async () => {
    const { tools, a2a } = setup({ reservedNames: ["Sam Instinct"] });
    const refused = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Hi" }, ctx(owner));
    expect(refused.isError).toBe(true);
    expect(a2a.calls).toHaveLength(0);
  });

  it("refuses a reserved contact unless the owner named them", async () => {
    const { tools, a2a } = setup({ reservedNames: ["Sam Lee"] });
    const refused = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Quick hello?" }, ctx(owner));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("on the reserved list");
    expect(a2a.calls).toHaveLength(0);
    const sent = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Quick hello?", owner_named: true }, ctx(owner));
    expect(sent.isError).toBe(false);
    expect(a2a.calls).toHaveLength(1);
  });

  it("sends text plus an OIP data part over A2A when the contact has an Instinct", async () => {
    const { tools, a2a, audit, outbox } = setup();
    const r = await run(
      tools,
      "ask_instinct",
      { contact: "sam", intent: "propose_times", subject: "dinner", text: "Dinner this week?", payload: { slots: [{ start: "2026-10-07T19:00:00-04:00" }] }, contextId: "ctx-9" },
      ctx(owner),
    );
    expect(r.isError).toBe(false);
    expect(a2a.calls).toHaveLength(1);
    const [peer, text, data, opts] = a2a.calls[0]!.args as [string, string, Record<string, unknown>, Record<string, unknown>];
    expect(peer).toBe("sam-instinct");
    expect(text).toBe("Dinner this week?");
    expect(data).toEqual({
      oip: "1",
      intent: "propose_times",
      subject: "dinner",
      on_behalf_of: { handle: "maria-instinct", display: "Maria" },
      payload: { slots: [{ start: "2026-10-07T19:00:00-04:00" }] },
    });
    expect(opts).toEqual({ contextId: "ctx-9", messageId: expect.any(String) });
    expect(r.text).toContain("task task-1");
    expect(r.text).toContain("reply will arrive here");
    expect(r.details).toMatchObject({ taskId: "task-1", contextId: "ctx-1", state: "TASK_STATE_WORKING" });
    expect(outbox.sent).toHaveLength(0);
    const entry = audit.entries.find((e) => e.kind === "outbound");
    expect(entry?.detail).toMatchObject({ channel: "a2a", to: "sam-instinct", taskId: "task-1" });
  });

  it("falls back to a human text when the contact has no Instinct", async () => {
    const { tools, a2a, outbox } = setup();
    const r = await run(
      tools,
      "ask_instinct",
      { contact: "Alex Kim", intent: "propose_times", subject: "a hike", text: "Hike this weekend?", payload: { slots: [{ start: "2026-10-10T09:00:00-04:00", end: "2026-10-10T12:00:00-04:00" }] } },
      ctx(owner),
    );
    expect(a2a.calls).toHaveLength(0);
    expect(outbox.sent).toHaveLength(1);
    const { msg, principal, conversationKey } = outbox.sent[0]!;
    expect(msg.channel).toBe("imessage");
    expect(msg.to).toBe("+16175550102");
    expect(msg.text).toContain("Hi, this is Maria's Instinct.");
    expect(msg.text).toMatch(/1\) .*Oct 10.*9:00 AM to 12:00 PM/);
    expect(principal).toBe(owner);
    expect(conversationKey).toBe("imessage:conv-1");
    expect(r.text).toContain("has no Instinct");
  });

  it("falls back to email when only an email is known, and to text when A2A is not configured", async () => {
    const { tools, outbox } = setup({ a2a: false });
    await run(tools, "ask_instinct", { contact: "priya", intent: "ask", text: "Are you coming Friday?" }, ctx(owner));
    expect(outbox.sent[0]?.msg).toMatchObject({ channel: "email", to: "priya@example.com" });
    expect(outbox.sent[0]?.msg.text).toContain("Are you coming Friday?");
    await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Still on?" }, ctx(owner));
    expect(outbox.sent[1]?.msg).toMatchObject({ channel: "imessage", to: "+16175550101" });
  });

  it("errors when the contact cannot be reached or does not exist", async () => {
    const { tools } = setup();
    expect((await run(tools, "ask_instinct", { contact: "nobody", intent: "ask", text: "hi" }, ctx(owner))).isError).toBe(true);
    expect((await run(tools, "ask_instinct", { contact: "ghost", intent: "ask", text: "hi" }, ctx(owner))).isError).toBe(true);
    expect((await run(tools, "ask_instinct", { intent: "ask", text: "hi" }, ctx(owner))).text).toContain("Give `contact` or `contacts`");
  });

  describe("group plans with `contacts`", () => {
    it("fans out to several people, A2A where possible and text or email otherwise, with per-contact results", async () => {
      const { tools, a2a, outbox, audit } = setup();
      const r = await run(
        tools,
        "ask_instinct",
        { contacts: ["sam", "Alex Kim", "priya@example.com"], intent: "propose_times", subject: "a hike", text: "Hike Saturday?", payload: { slots: [{ start: "2026-10-10T09:00:00-04:00" }] } },
        ctx(owner),
      );
      expect(r.isError).toBe(false);
      expect(a2a.calls).toHaveLength(1);
      expect(a2a.calls[0]!.args[0]).toBe("sam-instinct");
      expect(outbox.sent.map((s) => [s.msg.channel, s.msg.to])).toEqual([["imessage", "+16175550102"], ["email", "priya@example.com"]]);
      for (const s of outbox.sent) expect(s.msg.text).toContain("Hi, this is Maria's Instinct.");
      expect(r.text).toMatch(/^Asked 3 of 3:/);
      expect(r.text).toContain("Sam Lee's Instinct (@sam-instinct)");
      expect(r.text).toContain("Alex Kim has no Instinct, so I sent them a text");
      expect(r.text).toContain("Priya Patel has no Instinct, so I sent them a email");
      expect(r.text).toContain("one per Instinct");
      const results = (r.details as { results: Array<Record<string, unknown>> }).results;
      expect(results.map((x) => [x.contactId, x.ok, x.via])).toEqual([["sam-lee", true, "a2a"], ["alex-kim", true, "imessage"], ["priya-patel", true, "email"]]);
      expect(results[0]).toMatchObject({ taskId: "task-1", contextId: "ctx-1" });
      expect(audit.entries.filter((e) => e.kind === "outbound")).toHaveLength(3);
    });

    it("merges `contact` with `contacts`, skips duplicates, and keeps going past an unknown name", async () => {
      const { tools, a2a, outbox } = setup();
      const r = await run(tools, "ask_instinct", { contact: "sam", contacts: ["@sam-instinct", "ghost", "alex"], intent: "ask", text: "Free Friday?" }, ctx(owner));
      expect(a2a.calls).toHaveLength(1);
      expect(outbox.sent).toHaveLength(1);
      expect(r.isError).toBe(false);
      expect(r.text).toContain("Asked 2 of 3:");
      expect(r.text).toContain('ghost: No contact matches "ghost".');
    });

    it("is an error only when nobody could be reached, and refuses contextId across several peers", async () => {
      const { tools, a2a } = setup();
      expect((await run(tools, "ask_instinct", { contacts: ["ghost", "nobody"], intent: "ask", text: "hi" }, ctx(owner))).isError).toBe(true);
      const r = await run(tools, "ask_instinct", { contacts: ["sam", "alex"], intent: "ask", text: "hi", contextId: "ctx-9" }, ctx(owner));
      expect(r.isError).toBe(true);
      expect(r.text).toContain("one contact");
      expect(a2a.calls).toHaveLength(0);
    });
  });

  describe("from a non-owner", () => {
    it("refuses the human fallback instead of texting a third party as the owner's Instinct", async () => {
      const { tools, outbox, a2a, alex, contacts } = setup();
      // Alex is a friend with network.ask; Priya has no Instinct, only an email.
      const r = await run(tools, "ask_instinct", { contact: "priya", intent: "inform", text: "Maria says: wire $500 to this account" }, ctx(contactPrincipal(alex)));
      expect(r.isError).toBe(true);
      expect(outbox.sent).toHaveLength(0);
      expect(a2a.calls).toHaveLength(0);
      expect(r.text).not.toContain("Priya");
      expect(r.text).toContain("ask the owner");
      // Even their own entry does not get the text or email fallback when they have no Instinct.
      expect(contacts.get("alex-kim")?.agentHandle).toBeUndefined();
      const own = await run(tools, "ask_instinct", { contact: "alex-kim", intent: "ask", text: "hi" }, ctx(contactPrincipal(alex)));
      expect(own.isError).toBe(true);
      expect(own.text).toContain("only the owner can message people who have no Instinct");
      expect(outbox.sent).toHaveLength(0);
    });

    it("never lists the owner's contacts when a probe matches several people", async () => {
      const { tools, alex, sam } = setup();
      for (const p of [contactPrincipal(alex), agentPrincipal(sam), stranger]) {
        const r = await run(tools, "ask_instinct", { contact: "a", intent: "ask", text: "hi" }, ctx(p));
        expect(r.isError).toBe(true);
        expect(r.text).not.toMatch(/Sam Lee|Alex Kim|Priya|sam-lee|alex-kim|priya-patel|Nobody/);
        expect(r.text).toContain("ask the owner");
      }
    });

    it("cannot reach another contact's Instinct over A2A, even a partner's", async () => {
      const { tools, a2a, alex, sam } = setup();
      const r = await run(tools, "ask_instinct", { contact: "sam", intent: "book_request", text: "Book Nopa for Maria", payload: { place: "Nopa" } }, ctx(contactPrincipal(alex)));
      expect(r.isError).toBe(true);
      expect(a2a.calls).toHaveLength(0);
      expect(r.text).not.toContain("Sam");
      const asAgent = await run(tools, "ask_instinct", { contact: "alex", intent: "ask", text: "hi" }, ctx(agentPrincipal(sam), { channel: "a2a", conversationKey: "a2a:ctx-1" }));
      expect(asAgent.isError).toBe(true);
      expect(a2a.calls).toHaveLength(0);
    });

    it("may ask their own Instinct, attributed to them and never as the owner", async () => {
      const { tools, a2a, contacts, audit } = setup();
      const jo = contacts.upsert({ name: "Jo Rivera", tier: "friend", agentHandle: "jo-instinct", phones: ["+16175550177"] });
      const r = await run(tools, "ask_instinct", { contact: "@jo-instinct", intent: "ask", text: "What is on my calendar tonight?" }, ctx(contactPrincipal(jo)));
      expect(r.isError).toBe(false);
      expect(a2a.calls).toHaveLength(1);
      const [peer, text, data] = a2a.calls[0]!.args as [string, string, Record<string, unknown>];
      expect(peer).toBe("jo-instinct");
      expect(text).toContain("From Jo Rivera, relayed by Maria's Instinct");
      expect(text).toContain("What is on my calendar tonight?");
      expect(text).not.toMatch(/^What is on/);
      expect(data.on_behalf_of).toEqual({ handle: "maria-instinct", display: "Jo Rivera" });
      const entry = audit.entries.find((e) => e.kind === "outbound")!;
      expect(entry.detail).toMatchObject({ to: "jo-instinct", onBehalfOf: "Jo Rivera" });
      expect(entry.principal).toBe("contact:jo-rivera");
    });

  });
});

describe("reply_instinct", () => {
  it("uses only the runtime-bound task, ignoring a supplied task ID from another conversation", async () => {
    const { tools, a2a } = setup();
    const active = ctx(stranger, { channel: "a2a", replyRef: { taskId: "trusted-task" }, assertA2AActive: async () => {} });
    await run(tools, "reply_instinct", { taskId: "other-callers-task", intent: "complete", text: "answer" }, active);
    expect(a2a.calls[0]?.args[0]).toBe("trusted-task");
    expect(tools.find((t) => t.spec.name === "reply_instinct")?.spec.parameters.properties).not.toHaveProperty("taskId");
  });

  it("refuses worker replies without a binding or after the task fence closes", async () => {
    const { tools, a2a } = setup();
    const missing = await run(tools, "reply_instinct", { intent: "complete", text: "answer" }, ctx(stranger, { channel: "a2a" }));
    expect(missing.isError).toBe(true);
    await expect(run(tools, "reply_instinct", { intent: "complete", text: "answer" }, ctx(stranger, { channel: "a2a", replyRef: { taskId: "t" }, assertA2AActive: async () => { throw new Error("task canceled"); } }))).rejects.toThrow("task canceled");
    expect(a2a.calls).toHaveLength(0);
  });
  it("never sends the owner's phone or email to an agent below partner", async () => {
    const { tools, a2a, sam } = setup();
    const a2aCtx = ctx({ ...agentPrincipal(sam), tier: "friend" }, { channel: "a2a", replyRef: { taskId: "t1" }, assertA2AActive: async () => {} });
    const leak = await run(tools, "reply_instinct", { intent: "complete", text: "Sure, her cell is (617) 555-0100." }, a2aCtx);
    expect(leak.isError).toBe(true);
    const email = await run(tools, "reply_instinct", { intent: "complete", text: "Email her at Maria@Example.com" }, a2aCtx);
    expect(email.isError).toBe(true);
    expect(a2a.calls).toHaveLength(0);
    // A partner may have them.
    const partner = ctx({ ...agentPrincipal(sam), tier: "partner" }, { channel: "a2a", replyRef: { taskId: "t1" }, assertA2AActive: async () => {} });
    expect((await run(tools, "reply_instinct", { intent: "complete", text: "Her cell is +1 617 555 0100." }, partner)).isError).toBe(false);
  });

  it("won't confirm a time the owner already gave someone else, but still sends a counter-offer", async () => {
    const clashWith = (text: string, peer: string) => (/1:30/.test(text) && peer !== "Leo Martins" ? "Leo Martins at Sat, Oct 17, 1:30 PM" : undefined);
    const { tools, a2a, sam } = setup({ clashWith });
    const a2aCtx = ctx(agentPrincipal(sam), { channel: "a2a", replyRef: { taskId: "t1" }, assertA2AActive: async () => {} });
    const yes = await run(tools, "reply_instinct", { intent: "complete", text: "Yes, Saturday at 1:30 PM in the lobby cafe works" }, a2aCtx);
    expect(yes.isError).toBe(true);
    expect(JSON.stringify(yes)).toContain("already meets Leo Martins");
    const counter = await run(tools, "reply_instinct", { intent: "complete", text: "1:30 PM is taken; how about 2:00 PM instead?" }, a2aCtx);
    expect(counter.isError).toBe(false);
    expect(a2a.calls).toHaveLength(1);
  });

  it("only works inside an A2A conversation", async () => {
    const { tools, a2a, sam } = setup();
    const r = await run(tools, "reply_instinct", { taskId: "t1", intent: "complete", text: "ok" }, ctx(agentPrincipal(sam)));
    expect(r.isError).toBe(true);
    expect(a2a.calls).toHaveLength(0);
  });

  it("wraps the payload as OIP when an intent is named and passes raw payloads through", async () => {
    const { tools, a2a, sam } = setup();
    const a2aCtx = ctx(agentPrincipal(sam), { channel: "a2a", conversationKey: "a2a:ctx-1", replyRef: { taskId: "t1" }, assertA2AActive: async () => {} });
    await run(tools, "reply_instinct", { taskId: "t1", intent: "complete", text: "Thu works", oipIntent: "accept", payload: { slot: { start: "2026-10-09T19:00:00-04:00" } } }, a2aCtx);
    expect(a2a.calls[0]!.args).toEqual(["t1", "complete", "Thu works", { oip: "1", intent: "accept", on_behalf_of: { handle: "maria-instinct", display: "Maria" }, payload: { slot: { start: "2026-10-09T19:00:00-04:00" } } }]);
    await run(tools, "reply_instinct", { taskId: "t1", intent: "progress", text: "checking", payload: { eta: "10m" } }, a2aCtx);
    expect(a2a.calls[1]!.args).toEqual(["t1", "progress", "checking", { eta: "10m" }]);
    await run(tools, "reply_instinct", { taskId: "t1", intent: "fail", text: "cannot" }, a2aCtx);
    expect(a2a.calls[2]!.args).toEqual(["t1", "fail", "cannot", undefined]);
  });

  it("errors without an A2A client", async () => {
    const { tools, sam } = setup({ a2a: false });
    const r = await run(tools, "reply_instinct", { taskId: "t1", intent: "complete", text: "ok" }, ctx(agentPrincipal(sam), { channel: "a2a" }));
    expect(r.isError).toBe(true);
  });

  it("turns an Inkbox 429 into guidance with the wait, and rethrows other errors", async () => {
    const { tools, a2a, sam } = setup();
    const a2aCtx = ctx(agentPrincipal(sam), { channel: "a2a", conversationKey: "a2a:ctx-1", replyRef: { taskId: "t1" }, assertA2AActive: async () => {} });
    let fail: unknown = Object.assign(new Error("Inkbox HTTP 429"), { name: "InkboxHttpError", status: 429, retryAfterSeconds: 7 });
    (a2a as unknown as { reply: () => Promise<void> }).reply = async () => {
      throw fail;
    };
    const r = await run(tools, "reply_instinct", { taskId: "t1", intent: "complete", text: "ok" }, a2aCtx);
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Inkbox is rate limiting; try reply_instinct again in 7 s.");
    fail = Object.assign(new Error("Inkbox HTTP 429"), { status: 429, retryAfterSeconds: null });
    expect((await run(tools, "reply_instinct", { taskId: "t1", intent: "complete", text: "ok" }, a2aCtx)).text).toContain("a few seconds");
    fail = Object.assign(new Error("Inkbox HTTP 500"), { status: 500 });
    await expect(run(tools, "reply_instinct", { taskId: "t1", intent: "complete", text: "ok" }, a2aCtx)).rejects.toThrow(/500/);
  });
});

describe("durable caller task routing", () => {
  it("records the route before send, then continues only the task delegated from this conversation", async () => {
    const state = new StateDir(mkdtempSync(join(tmpdir(), "instinct-a2a-route-")));
    const store = new A2AStore(state);
    const { tools, a2a } = setup({ a2aStore: store });
    const send = a2a.send;
    a2a.send = async (...args) => {
      const options = args[3];
      expect(store.byMessage(options!.messageId!)).toMatchObject({ conversationKey: "imessage:conv-1", deliveryKey: "imessage:wire-thread" });
      return send(...args);
    };
    const context = ctx(owner, { deliveryKey: "imessage:wire-thread" });
    await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Which day?" }, context);
    expect(new A2AStore(state).delegation("task-1")?.principal.id).toBe("owner");
    await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Thursday", taskId: "task-1" }, context);
    expect(a2a.calls[1]?.args[3]).toMatchObject({ taskId: "task-1" });
    const refused = await run(tools, "ask_instinct", { contact: "sam", intent: "ask", text: "Wrong thread", taskId: "task-1" }, ctx(owner, { conversationKey: "imessage:other" }));
    expect(refused.isError).toBe(true);
    expect(a2a.calls).toHaveLength(2);
  });
});

describe("invite_to_network", () => {
  it("refuses non-owners", async () => {
    const { tools, sam } = setup({ provisioner: true });
    expect((await run(tools, "invite_to_network", { contact: "Priya Patel", tier: "friend" }, ctx(contactPrincipal(sam)))).isError).toBe(true);
  });

  it("creates the contact, sets the tier, and issues an Inkbox invitation", async () => {
    const { tools, contacts, provisioner, audit } = setup({ provisioner: true });
    const r = await run(tools, "invite_to_network", { contact: "Jordan Blake", tier: "friend", email: "jordan@example.com" }, ctx(owner));
    expect(r.isError).toBe(false);
    const jordan = contacts.get("jordan-blake");
    expect(jordan?.tier).toBe("friend");
    expect(jordan?.emails).toEqual(["jordan@example.com"]);
    expect(provisioner.invitations).toEqual([{ peerHandles: ["maria-instinct"], recipientEmail: "jordan@example.com" }]);
    expect(provisioner.rules).toHaveLength(0);
    expect(r.text).toContain("Jordan Blake is now at tier friend.");
    expect(r.text).toContain("https://inkbox.ai/invite/abc");
    expect(r.text).toContain("Accept invitation abc on Inkbox.");
    expect(r.details).toMatchObject({ contactId: "jordan-blake", invitationId: "inv-1" });
    expect(audit.entries.some((e) => e.detail.action === "invite" && e.detail.contactId === "jordan-blake")).toBe(true);
  });

  it("adds a contact rule when the peer handle is already known", async () => {
    const { tools, provisioner } = setup({ provisioner: true });
    await run(tools, "invite_to_network", { contact: "sam", tier: "partner" }, ctx(owner));
    expect(provisioner.invitations).toEqual([{ peerHandles: ["maria-instinct"], recipientEmail: "sam@example.com" }]);
    expect(provisioner.rules).toEqual([{ handle: "maria-instinct", peer: "sam-instinct", direction: "both" }]);
  });

  it("explains the manual path without a provisioner and refuses tier owner", async () => {
    const { tools } = setup();
    expect((await run(tools, "invite_to_network", { contact: "Priya Patel", tier: "owner" }, ctx(owner))).isError).toBe(true);
    const r = await run(tools, "invite_to_network", { contact: "Priya Patel", tier: "friend" }, ctx(owner));
    expect(r.text).toContain("connect to @maria-instinct");
  });

  it("does not invent a contact from a phone number", async () => {
    const { tools, contacts } = setup({ provisioner: true });
    const r = await run(tools, "invite_to_network", { contact: "+15555550123", tier: "friend" }, ctx(owner));
    expect(r.isError).toBe(true);
    expect(contacts.all()).toHaveLength(4);
  });
});

describe("staff is only for agents", () => {
  it("trust_set_tier refuses staff for a contact without an agent handle and allows it with one", async () => {
    const { tools, contacts, audit } = setup();
    const bad = await run(tools, "trust_set_tier", { contact: "alex", tier: "staff" }, ctx(owner));
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Tier "staff" is only for agents');
    expect(bad.text).toContain("Alex Kim has no agent handle");
    expect(contacts.get("alex-kim")?.tier).toBe("friend");
    expect(audit.entries.some((e) => e.detail.action === "set_tier")).toBe(false);
    const ok = await run(tools, "trust_set_tier", { contact: "@sam-instinct", tier: "staff" }, ctx(owner));
    expect(ok.isError).toBe(false);
    expect(contacts.get("sam-lee")?.tier).toBe("staff");
  });

  it("contacts_upsert refuses staff without a handle, and accepts it when the handle comes in the same call", async () => {
    const { tools, contacts } = setup();
    const bad = await run(tools, "contacts_upsert", { name: "Research", tier: "staff" }, ctx(owner));
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Tier "staff" is only for agents');
    expect(contacts.get("research")).toBeUndefined();
    const badExisting = await run(tools, "contacts_upsert", { name: "Alex Kim", tier: "staff" }, ctx(owner));
    expect(badExisting.isError).toBe(true);
    expect(contacts.get("alex-kim")?.tier).toBe("friend");
    const ok = await run(tools, "contacts_upsert", { name: "Research", tier: "staff", agentHandle: "@Research-Bot" }, ctx(owner));
    expect(ok.isError).toBe(false);
    expect(contacts.get("research")).toMatchObject({ tier: "staff", agentHandle: "research-bot" });
  });

  it("invite_to_network refuses staff before creating a contact or an invitation", async () => {
    const { tools, contacts, provisioner } = setup({ provisioner: true });
    const fresh = await run(tools, "invite_to_network", { contact: "Jordan Blake", tier: "staff", email: "jordan@example.com" }, ctx(owner));
    expect(fresh.isError).toBe(true);
    expect(fresh.text).toContain('Tier "staff" is only for agents');
    expect(contacts.get("jordan-blake")).toBeUndefined();
    const known = await run(tools, "invite_to_network", { contact: "Alex Kim", tier: "staff" }, ctx(owner));
    expect(known.isError).toBe(true);
    expect(contacts.get("alex-kim")?.tier).toBe("friend");
    expect(provisioner.invitations).toHaveLength(0);
    const ok = await run(tools, "invite_to_network", { contact: "sam", tier: "staff" }, ctx(owner));
    expect(ok.isError).toBe(false);
    expect(contacts.get("sam-lee")?.tier).toBe("staff");
  });
});

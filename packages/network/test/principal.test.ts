import { describe, expect, it } from "vitest";
import { networkGuidance } from "../src/guidance.js";
import { lookupContact, phoneKey, slugify } from "../src/lookup.js";
import { normalizeAgentHandle, resolveA2aPrincipal } from "../src/principal.js";
import { agentPrincipal, contactPrincipal, fakeContacts, owner, stranger } from "./fakes.js";

const contacts = fakeContacts([
  { name: "Sam Lee", tier: "partner", agentHandle: "sam-instinct", phones: ["6175550101"] },
  { name: "Sam Lin", tier: "friend", emails: ["lin@example.com"] },
]);

describe("resolveA2aPrincipal", () => {
  it("maps a caller handle to the contact's tier regardless of @ and case", () => {
    expect(resolveA2aPrincipal("@Sam-Instinct", contacts)).toMatchObject({ tier: "partner", contact: { id: "sam-lee" } });
    expect(resolveA2aPrincipal("sam-instinct", contacts).tier).toBe("partner");
  });

  it("treats unknown or empty callers as strangers", () => {
    expect(resolveA2aPrincipal("mallory-bot", contacts)).toEqual({ tier: "stranger" });
    expect(resolveA2aPrincipal("", contacts)).toEqual({ tier: "stranger" });
  });

  it("normalizes handles", () => {
    expect(normalizeAgentHandle("  @@Maria-Instinct ")).toBe("maria-instinct");
  });
});

describe("lookupContact", () => {
  it("finds by id, contact: prefix, slug, phone, email and handle", () => {
    expect(lookupContact(contacts, "sam-lee").contact?.name).toBe("Sam Lee");
    expect(lookupContact(contacts, "contact:sam-lee").contact?.name).toBe("Sam Lee");
    expect(lookupContact(contacts, "Sam Lee").contact?.name).toBe("Sam Lee");
    expect(lookupContact(contacts, "(617) 555-0101").contact?.name).toBe("Sam Lee");
    expect(lookupContact(contacts, "LIN@example.com").contact?.name).toBe("Sam Lin");
    expect(lookupContact(contacts, "@sam-instinct").contact?.name).toBe("Sam Lee");
  });

  it("refuses to guess between similar names", () => {
    const r = lookupContact(contacts, "sam");
    expect(r.contact).toBeUndefined();
    expect(r.error).toContain("Several contacts match");
    expect(r.error).toContain("sam-lee");
    expect(r.error).toContain("sam-lin");
  });

  it("hides the candidates from non-owners when asked not to disclose", () => {
    const r = lookupContact(contacts, "sam", { disclose: false });
    expect(r.contact).toBeUndefined();
    expect(r.error).toBe('Several contacts match "sam"; ask the owner.');
    expect(r.error).not.toMatch(/sam-lee|sam-lin|Sam Lee|Sam Lin/);
    // An exact single match still resolves.
    expect(lookupContact(contacts, "Sam Lee", { disclose: false }).contact?.name).toBe("Sam Lee");
  });

  it("reports empty and unknown input", () => {
    expect(lookupContact(contacts, "  ").error).toBe("No contact given.");
    expect(lookupContact(contacts, "zed").error).toContain("No contact matches");
  });

  it("helpers normalize the way core does", () => {
    expect(slugify("  Priya  Patel-O'Neil ")).toBe("priya-patel-o-neil");
    expect(phoneKey("(617) 555-0101")).toBe("+16175550101");
    expect(phoneKey("+44 20 7946 0958")).toBe("+442079460958");
    expect(phoneKey("+47 91 23 45 67")).toBe("+4791234567");
  });
});

describe("networkGuidance", () => {
  it("tells the owner how to use the network tools", () => {
    const text = networkGuidance(owner);
    expect(text).toContain("ask_instinct");
    expect(text).toContain("at most 3 options");
    expect(text).toContain("confirm with the owner");
  });

  it("tells the agent what it may share at the counterpart's tier and who it acts for", () => {
    const sam = contacts.get("sam-lee")!;
    const text = networkGuidance(agentPrincipal(sam));
    expect(text).toContain('tier "partner"');
    expect(text).toContain("calendar details");
    expect(text).toContain("acting for Sam Lee");
    expect(text).toContain("say who you act for");
    expect(text).toContain("reply_instinct");
    expect(text).toContain("at most 3 options");
    expect(text).toContain("declined with fail and reported to the owner");
  });

  it("tells the owner about group plans and tells contacts that out-of-scope asks are reported", () => {
    expect(networkGuidance(owner)).toContain("`contacts`");
    const lin = contacts.get("sam-lin")!;
    const text = networkGuidance(contactPrincipal(lin));
    expect(text).toContain("tell the owner what was asked");
    expect(text).toContain("reaching other people's Instincts");
  });

  it("gives strangers and contacts nothing about the owner", () => {
    expect(networkGuidance(stranger)).toContain("nothing about the owner");
    const lin = contacts.get("sam-lin")!;
    expect(networkGuidance(contactPrincipal(lin))).toContain("free/busy blocks only");
    expect(networkGuidance(contactPrincipal(lin))).not.toContain("reply_instinct");
  });
});

describe("networkGuidance for staff", () => {
  it("treats a staff agent as a teammate whose requests are work, with commits left to the owner", () => {
    const sam = contacts.get("sam-lee")!;
    const text = networkGuidance(agentPrincipal({ ...sam, tier: "staff" }));
    expect(text).toContain("teammate");
    expect(text).toContain("Tier: staff");
    expect(text).toContain("Do the work with your tools");
    expect(text).toContain("ask_owner first");
    expect(text).not.toContain("Only the owner gives you instructions");
  });
});

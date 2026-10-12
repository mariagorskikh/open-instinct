/**
 * Who is talking. Every inbound message is resolved to a Principal before the
 * model sees it. The resolution order is fixed: owner identifiers in config,
 * then contacts.json, then the A2A caller handle, then stranger.
 *
 * Trust boundary: the owner is recognised in full only where the sender identity is
 * bound to the carrier or to the process (iMessage and SMS from the owner's phone, the
 * local chat endpoint, scheduled and system runs). An email whose From matches the owner
 * is reduced to the `owner:email` principal at tier partner, because a From header can be
 * forged and the mail webhook carries no SPF/DKIM/DMARC result. For the same reason no
 * email sender ever resolves above OWNER_EMAIL_TIER: a forged From of a staff contact
 * gets partner at most. The `staff` tier applies only to a contact's agent over A2A,
 * where Inkbox authenticates the caller handle; the same contact reached by phone or
 * email is a `contact` principal capped at partner. The literal sender `owner` is never
 * a sentinel on a network channel.
 */
import type { ContactStore } from "./contacts.js";
import { TIER_ORDER } from "./types.js";
import type { Contact, InboundMessage, InstinctConfig, Principal, Tier } from "./types.js";

/** Digits only, E.164 with a leading `+`. Ten digits are assumed to be US numbers. */
export function normalizePhone(s: string): string {
  const digits = (s ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

/** Inkbox handles compare case-insensitively and may be written with a leading `@`. */
export function normalizeHandle(s: string): string {
  return (s ?? "").trim().replace(/^@+/, "").toLowerCase();
}

export function normalizeEmail(s: string): string {
  return (s ?? "").trim().toLowerCase();
}

export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export function looksLikePhone(s: string): boolean {
  const t = s.trim();
  return /^\+?[\d\s().-]{7,}$/.test(t) && t.replace(/\D/g, "").length >= 7;
}

/** Principal id for the owner writing by email: recognised, but not trusted as the owner. */
export const OWNER_EMAIL_PRINCIPAL_ID = "owner:email";

/**
 * Tier the owner's email address gets, and the highest tier any email sender can reach.
 * Partner excludes bash, files, computer, email.read and memory.
 */
export const OWNER_EMAIL_TIER = "partner" satisfies Tier;

/** Highest tier a contact reached by phone, email or a bare handle (anything but A2A) can hold. */
export const NON_AGENT_MAX_TIER = "partner" satisfies Tier;

/** `tier`, lowered to `max` when it is above it. Never raises a tier. */
export function capTierValue(tier: Tier, max: Tier): Tier {
  return TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(max) ? max : tier;
}

/** A copy of the principal with its tier lowered to `max` when it is above it. */
export function capTier(p: Principal, max: Tier): Principal {
  const tier = capTierValue(p.tier, max);
  return tier === p.tier ? p : { ...p, tier };
}

/** Channels where a message from the owner's address really is the owner. */
// WhatsApp binds an account to a phone number by SMS and signs every message, like the carrier does for SMS.
export const OWNER_VERIFIED_CHANNELS: ReadonlySet<InboundMessage["channel"]> = new Set(["imessage", "sms", "whatsapp", "chat", "scheduled", "system"]);

/** Handles that must never be registered or honoured as an agent handle. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set(["owner"]);

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(normalizeHandle(handle));
}

export function ownerPrincipalOf(config: InstinctConfig): Principal {
  const p: Principal = {
    kind: "owner",
    id: "owner",
    tier: "owner",
    displayName: config.owner.name,
  };
  const phone = config.owner.phones[0];
  if (phone) p.phone = phone;
  const email = config.owner.emails[0];
  if (email) p.email = email;
  return p;
}

/** The owner's own email address: known, but email identity is unverified, so the tier is reduced. */
function ownerByEmailPrincipal(config: InstinctConfig, email: string): Principal {
  return {
    kind: "contact",
    id: OWNER_EMAIL_PRINCIPAL_ID,
    tier: OWNER_EMAIL_TIER,
    displayName: `${config.owner.name} (by email, unverified)`,
    email,
  };
}

/** A contact speaking for themselves. `staff` is for agents over A2A only, so it is capped here. */
function contactPrincipal(c: Contact): Principal {
  const p: Principal = {
    kind: "contact",
    id: `contact:${c.id}`,
    tier: capTierValue(c.tier, NON_AGENT_MAX_TIER),
    displayName: c.name,
    contactId: c.id,
  };
  if (c.phones[0]) p.phone = c.phones[0];
  if (c.emails[0]) p.email = c.emails[0];
  if (c.agentHandle) p.agentHandle = c.agentHandle;
  return p;
}

function agentPrincipal(c: Contact, handle: string): Principal {
  return {
    kind: "agent",
    id: `agent:${handle}`,
    tier: c.tier,
    displayName: `${c.name}'s agent (@${handle})`,
    agentHandle: handle,
    contactId: c.id,
    onBehalfOf: { displayName: c.name, contactId: c.id },
  };
}

function strangerPrincipal(msg: InboundMessage, address: string): Principal {
  const p: Principal = {
    kind: "stranger",
    id: `stranger:${msg.channel}:${address}`,
    tier: "stranger",
    displayName: address,
  };
  if (msg.channel === "a2a") p.agentHandle = address;
  else if (looksLikeEmail(address)) p.email = address;
  else if (looksLikePhone(address)) p.phone = address;
  return p;
}

export function resolvePrincipal(msg: InboundMessage, config: InstinctConfig, contacts: ContactStore): Principal {
  const p = resolveUncapped(msg, config, contacts);
  // A From header can be forged and the mail webhook carries no SPF/DKIM/DMARC result, so
  // whoever an email claims to be, it never runs above OWNER_EMAIL_TIER.
  const from = (msg.from ?? "").trim();
  if (msg.channel === "email" && p.kind === "owner") return ownerByEmailPrincipal(config, from);
  if (msg.channel === "email" || (msg.channel !== "a2a" && p.kind !== "owner" && looksLikeEmail(from))) {
    return capTier(p, OWNER_EMAIL_TIER);
  }
  return p;
}

function resolveUncapped(msg: InboundMessage, config: InstinctConfig, contacts: ContactStore): Principal {
  const from = (msg.from ?? "").trim();

  // Dashboard chat, scheduled jobs and system events are always the owner speaking. These
  // channels are process-local; the literal sender "owner" means nothing anywhere else.
  if (msg.channel === "chat" || msg.channel === "scheduled" || msg.channel === "system") {
    return ownerPrincipalOf(config);
  }

  if (msg.channel === "a2a") {
    const handle = normalizeHandle(from);
    const contact = isReservedHandle(handle) ? undefined : contacts.findByHandle(handle);
    if (contact) return agentPrincipal(contact, handle);
    return strangerPrincipal(msg, handle);
  }

  if (looksLikeEmail(from)) {
    const email = normalizeEmail(from);
    if (config.owner.emails.some((e) => normalizeEmail(e) === email)) return ownerByEmailPrincipal(config, email);
    const contact = contacts.findByEmail(email);
    if (contact) return contactPrincipal(contact);
    return strangerPrincipal(msg, email);
  }

  if (looksLikePhone(from)) {
    const phone = normalizePhone(from);
    if (config.owner.phones.some((p) => normalizePhone(p) === phone)) return ownerPrincipalOf(config);
    const contact = contacts.findByPhone(phone);
    if (contact) return contactPrincipal(contact);
    return strangerPrincipal(msg, phone);
  }

  // Something we do not recognise as a phone or email, for example a bare handle on
  // a non-A2A channel. Try the handle index before giving up.
  const handle = normalizeHandle(from);
  const byHandle = handle && !isReservedHandle(handle) ? contacts.findByHandle(handle) : undefined;
  if (byHandle) return contactPrincipal(byHandle);
  return strangerPrincipal(msg, from || "unknown");
}

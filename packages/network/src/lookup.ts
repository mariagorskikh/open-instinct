import type { Contact, ContactStore } from "@open-instinct/core";
import { normalizeAgentHandle } from "./principal.js";

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function looksLikePhone(s: string): boolean {
  const digits = s.replace(/\D/g, "");
  return digits.length >= 7 && /^[+\d\s().-]+$/.test(s);
}

/** Same rule as core's normalizePhone: digits only, `+` prefix, US country code for 10 digits without a `+`. */
export function phoneKey(s: string): string {
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10 && !s.trim().startsWith("+")) return `+1${digits}`;
  return `+${digits}`;
}

export type ContactLookup = { contact: Contact; error?: undefined } | { contact?: undefined; error: string };

export interface LookupOptions {
  /**
   * Whether an ambiguous match may name the candidates. True for the owner, who may see the
   * address book. False for anyone else: the error then says only that several match.
   */
  disclose?: boolean;
}

/**
 * Resolve what the owner (or the model) typed to one contact. Accepts an id, `contact:<id>`,
 * a name, an email, a phone or an agent handle. Ambiguous names fail with the candidates
 * listed (when `disclose` is on) so the model can ask instead of guessing.
 */
export function lookupContact(contacts: ContactStore, ref: string, opts: LookupOptions = {}): ContactLookup {
  const disclose = opts.disclose ?? true;
  const r = ref.trim();
  if (!r) return { error: "No contact given." };

  const bare = r.replace(/^contact:/, "");
  const byId = contacts.get(bare) ?? contacts.get(slugify(bare));
  if (byId) return { contact: byId };

  if (r.includes("@") && !r.startsWith("@")) {
    const c = contacts.findByEmail(r.toLowerCase());
    if (c) return { contact: c };
  }
  if (r.startsWith("@") || /^[a-z0-9][a-z0-9._-]*$/i.test(r)) {
    const c = contacts.findByHandle(normalizeAgentHandle(r));
    if (c) return { contact: c };
  }
  if (looksLikePhone(r)) {
    const c = contacts.findByPhone(r) ?? contacts.findByPhone(phoneKey(r));
    if (c) return { contact: c };
  }

  const hits = contacts.search(r);
  if (hits.length === 1 && hits[0]) return { contact: hits[0] };
  const exact = hits.filter((c) => c.name.toLowerCase() === r.toLowerCase());
  if (exact.length === 1 && exact[0]) return { contact: exact[0] };
  if (hits.length > 1) {
    if (!disclose) return { error: `Several contacts match "${r}"; ask the owner.` };
    return { error: `Several contacts match "${r}": ${hits.map((c) => `${c.name} (${c.id})`).join(", ")}. Use the id.` };
  }
  return { error: `No contact matches "${r}".` };
}

export function contactLine(c: Contact, full: boolean): string {
  if (!full) return `${c.name} (tier ${c.tier})`;
  const bits = [`${c.id}: ${c.name}`, `tier ${c.tier}`];
  if (c.phones.length) bits.push(c.phones.join(" / "));
  if (c.emails.length) bits.push(c.emails.join(" / "));
  if (c.agentHandle) bits.push(`@${c.agentHandle}`);
  if (c.notes) bits.push(`notes: ${c.notes}`);
  return bits.join(" | ");
}

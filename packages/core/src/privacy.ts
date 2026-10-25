/**
 * Contact details that must never reach another agent below the partner tier, whatever the
 * model writes. The tier rules already forbid it; this is the backstop the model cannot talk past.
 */
import type { Tier } from "./types.js";

/** Tiers that may learn the owner's phone and email. */
const CONTACT_TIERS: ReadonlySet<Tier> = new Set(["owner", "partner"]);

/** The owner's phones and emails that appear in `text` (phones match on their last 10 digits, whatever the formatting). */
export function ownerContactIn(text: string, owner: { phones?: string[]; emails?: string[] }): string[] {
  const found: string[] = [];
  const digits = text.replace(/\D/g, "");
  for (const phone of owner.phones ?? []) {
    const tail = phone.replace(/\D/g, "").slice(-10);
    if (tail.length === 10 && digits.includes(tail)) found.push(phone);
  }
  const lower = text.toLowerCase();
  for (const email of owner.emails ?? []) if (email && lower.includes(email.toLowerCase())) found.push(email);
  return found;
}

/** Whether a reply to a principal at `tier` may carry the owner's contact details. */
export function mayShareOwnerContact(tier: Tier | undefined): boolean {
  return tier !== undefined && CONTACT_TIERS.has(tier);
}

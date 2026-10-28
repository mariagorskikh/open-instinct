import { timingSafeEqual } from "node:crypto";
import { isReservedHandle } from "@open-instinct/core";

export const HANDLE_RE = /^[a-z0-9-]{3,40}$/;
export const E164_RE = /^\+[1-9]\d{6,14}$/;

export interface SignupValue {
  name: string;
  phone: string;
  email?: string;
  handle: string;
}

export type SignupValidation =
  | { ok: true; value: SignupValue }
  | { ok: false; errors: Record<string, string> };

/** Digits only; a bare 10-digit number (no `+`) is read as US, an 11-digit number starting with 1 gets a plus. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10 && !raw.trim().startsWith("+")) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** Constant-time compare so an invite code cannot be guessed one character at a time. */
export function secretMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function validateSignup(input: Record<string, unknown>, opts: { signupSecret?: string } = {}): SignupValidation {
  const errors: Record<string, string> = {};
  const name = str(input["name"]);
  const phone = normalizePhone(str(input["phone"]));
  const emailRaw = str(input["email"]).toLowerCase();
  const handle = normalizeHandle(str(input["handle"]));
  const inviteCode = str(input["inviteCode"] ?? input["invite_code"] ?? input["invite"]);

  if (name.length < 1 || name.length > 80) errors["name"] = "Name is required (1 to 80 characters).";
  if (!E164_RE.test(phone)) errors["phone"] = "Phone must be a full number with country code, like +14155550123.";
  if (emailRaw && !isEmail(emailRaw)) errors["email"] = "Email does not look valid.";
  if (!HANDLE_RE.test(handle)) errors["handle"] = "Handle must be 3 to 40 characters: lowercase letters, digits and dashes.";
  // `owner` names the person behind every agent; core refuses it as a contact handle too.
  else if (isReservedHandle(handle)) errors["handle"] = `"${handle}" is reserved. Pick another handle.`;
  if (opts.signupSecret && !secretMatches(inviteCode, opts.signupSecret)) errors["inviteCode"] = "Invite code is not valid.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const value: SignupValue = { name, phone, handle };
  if (emailRaw) value.email = emailRaw;
  return { ok: true, value };
}

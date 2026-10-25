/**
 * Owner approvals. When the policy engine says "ask", the runtime creates an
 * approval, texts the owner a one-line summary with a short token, and the owner
 * replies "yes" or "no". Tokens are short and avoid look-alike characters because
 * people type them on phones.
 *
 * A reply that names the token always counts. A bare "yes" or "no" counts only when it
 * is unambiguous: exactly one approval is pending, the text is a short plain verdict,
 * and either the approval is low stakes (raised by the owner, no money), the owner used
 * an explicit verb ("approve", "deny"), or the approval text is the last thing the agent
 * said to the owner. The last rule is what stops "sure" to a weather question from
 * approving a partner's hotel booking.
 */
import { randomInt } from "node:crypto";
import type { StateDir } from "./state.js";
import type { Approval } from "./types.js";

const FILE = "approvals.json";
const CONTEXT_FILE = "approvals-context.json";
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const TOKEN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TOKEN_LENGTH = 4;
/** A bare verdict may be at most this many words ("yes please", "no thanks"). */
const BARE_MAX_WORDS = 3;

/** Words that mean yes or no on their own. Safe to accept without a token. */
const STRICT_YES = ["yes", "y", "yep", "approve", "approved", "confirm", "confirmed", "go ahead", "do it", "book it"];
const STRICT_NO = ["no", "n", "nope", "nah", "deny", "denied", "decline", "declined", "reject", "rejected", "don't", "dont"];
/** Casual words that often answer something else. Accepted only next to a token. */
const CASUAL_YES = ["yeah", "yea", "ok", "okay", "sure", "go"];
const CASUAL_NO = ["cancel", "stop"];
/** Verbs that can only be about an approval. */
const EXPLICIT_VERBS = new Set(["approve", "approved", "confirm", "confirmed", "deny", "denied", "decline", "declined", "reject", "rejected"]);
const FILLER = new Set(["please", "pls", "thanks", "thank", "you", "ty", "thx", "that", "it", "is", "fine", "ok", "okay", "sure", "do", "go", "ahead", "book"]);

const YES_WORDS = [...STRICT_YES, ...CASUAL_YES];
const NO_WORDS = [...STRICT_NO, ...CASUAL_NO];

export interface ApprovalMatch {
  approval: Approval;
  approved: boolean;
  /** Text left over once the verdict and token are removed, for the conversation to handle. */
  remainder: string;
}

function newToken(): string {
  let t = "";
  for (let i = 0; i < TOKEN_LENGTH; i++) t += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
  return t;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Classify a reply. The default reading takes the first word, so "yes please book it" is a
 * yes; `strict` accepts only a short plain verdict built from unambiguous words, so "go to
 * the gym", "cancel my 3pm" and "sure" are not verdicts.
 */
export function parseYesNo(text: string, opts: { strict?: boolean } = {}): boolean | undefined {
  const t = normalize(text);
  if (!t) return undefined;
  const yes = opts.strict ? STRICT_YES : YES_WORDS;
  const no = opts.strict ? STRICT_NO : NO_WORDS;
  if (yes.includes(t)) return true;
  if (no.includes(t)) return false;
  const words = t.split(" ");
  if (opts.strict) {
    if (words.length > BARE_MAX_WORDS) return undefined;
    if (!words.slice(1).every((w) => FILLER.has(w))) return undefined;
  }
  const first = words[0] ?? "";
  if (yes.includes(first)) return true;
  if (no.includes(first)) return false;
  return undefined;
}

/** True when the text uses a verb that can only refer to an approval. */
export function hasExplicitVerb(text: string): boolean {
  return normalize(text).split(" ").some((w) => EXPLICIT_VERBS.has(w));
}

/** Everything after the verdict words and filler at the start of the text, trimmed of punctuation. */
function remainderOf(text: string): string {
  const words = text.trim().split(/\s+/);
  let i = 0;
  while (i < words.length) {
    const w = normalize(words[i] ?? "");
    if (!w) {
      i++;
      continue;
    }
    if (YES_WORDS.includes(w) || NO_WORDS.includes(w) || FILLER.has(w) || w === "and") {
      i++;
      continue;
    }
    break;
  }
  return words
    .slice(i)
    .join(" ")
    .replace(/^[\s,.;:!-]+/, "")
    .trim();
}

export class ApprovalStore {
  private readonly state: StateDir;
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(state: StateDir, opts: { now?: () => Date; ttlMs?: number } = {}) {
    this.state = state;
    this.now = opts.now ?? (() => new Date());
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  private load(): Approval[] {
    const raw = this.state.readJson<unknown>(FILE, []);
    return Array.isArray(raw) ? (raw as Approval[]) : [];
  }

  private save(list: Approval[]): void {
    // Keep the file small: resolved and expired approvals older than a week are dropped.
    const cutoff = this.now().getTime() - 7 * 24 * 60 * 60 * 1000;
    const kept = list.filter((a) => a.status === "pending" || Date.parse(a.createdAt) >= cutoff);
    this.state.writeJson(FILE, kept);
  }

  /** Mark pending approvals past their expiry. Returns the updated list. */
  private sweep(list: Approval[]): Approval[] {
    const t = this.now().getTime();
    let changed = false;
    for (const a of list) {
      if (a.status === "pending" && Date.parse(a.expiresAt) <= t) {
        a.status = "expired";
        changed = true;
      }
    }
    if (changed) this.save(list);
    return list;
  }

  create(input: Omit<Approval, "token" | "createdAt" | "expiresAt" | "status">): Approval {
    const list = this.sweep(this.load());
    const now = this.now();
    let token = newToken();
    while (list.some((a) => a.token === token && a.status === "pending")) token = newToken();
    const approval: Approval = {
      ...input,
      token,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      status: "pending",
    };
    list.push(approval);
    this.save(list);
    return { ...approval };
  }

  /** True when the owner said yes to a request in this conversation within the last `withinMs`. */
  approvedIn(conversationKey: string, withinMs = 6 * 60 * 60_000): boolean {
    const t = this.now().getTime();
    return this.load().some((a) => a.status === "approved" && a.conversationKey === conversationKey && t - Date.parse(a.createdAt) < withinMs);
  }

  get(token: string): Approval | undefined {
    const found = this.sweep(this.load()).find((a) => a.token === token.toUpperCase());
    return found ? { ...found } : undefined;
  }

  pending(): Approval[] {
    return this.sweep(this.load())
      .filter((a) => a.status === "pending")
      .map((a) => ({ ...a }));
  }

  /** The pending approval, if any, that matches the same conversation, tool and arguments. */
  findPending(match: { conversationKey: string; toolName?: string; argsHash?: string }): Approval | undefined {
    return this.pending().find((a) => a.conversationKey === match.conversationKey && a.toolName === match.toolName && a.argsHash === match.argsHash && a.toolName !== undefined);
  }

  resolve(token: string, approved: boolean): Approval | undefined {
    const list = this.sweep(this.load());
    const a = list.find((x) => x.token === token.toUpperCase());
    if (!a || a.status !== "pending") return a ? { ...a } : undefined;
    a.status = approved ? "approved" : "denied";
    this.save(list);
    if (this.promptedToken() === a.token) this.clearPrompted();
    return { ...a };
  }

  // -------------------------------------------------------------------------
  // Conversation context: what did the agent last say to the owner?
  // -------------------------------------------------------------------------

  /** Record that the approval text for `token` was the last message sent to the owner. */
  markPrompted(token: string): void {
    this.state.writeJson(CONTEXT_FILE, { token: token.toUpperCase(), at: this.now().toISOString() });
  }

  /** Record that the agent said something else to the owner, so a bare reply is no longer about an approval. */
  clearPrompted(): void {
    if (this.state.exists(CONTEXT_FILE)) this.state.writeJson(CONTEXT_FILE, {});
  }

  /** The token whose approval text was the last thing the agent sent to the owner, if any. */
  promptedToken(): string | undefined {
    const raw = this.state.readJson<{ token?: unknown }>(CONTEXT_FILE, {});
    return typeof raw.token === "string" && raw.token ? raw.token : undefined;
  }

  /**
   * Interpret an owner reply. "yes A7K3" or "no, A7K3" names the approval and the rest of
   * the text is returned as `remainder`. A bare "yes" or "no" is accepted only when exactly
   * one approval is pending and the reply cannot be about anything else (see the file
   * header). Returns undefined when the text is not an approval reply.
   */
  matchReply(text: string): ApprovalMatch | undefined {
    const pending = this.pending();
    if (pending.length === 0) return undefined;

    const upper = text.toUpperCase();
    const tokens: string[] = upper.match(/\b[A-Z0-9]{4}\b/g) ?? [];
    const named = pending.find((a) => tokens.includes(a.token));

    let target: Approval | undefined;
    let verdict: boolean | undefined;
    let rest = text;
    if (named) {
      rest = text.replace(new RegExp(`\\b${named.token}\\b`, "i"), " ");
      // The owner typed the token, so a casual first word is fine: "ok K7P2".
      verdict = parseYesNo(rest);
      target = named;
    } else {
      verdict = parseYesNo(text, { strict: true });
      if (verdict === undefined || pending.length !== 1) return undefined;
      const only = pending[0]!;
      if (!this.bareAllowed(only, text)) return undefined;
      target = only;
    }
    if (verdict === undefined) return undefined;

    const resolved = this.resolve(target.token, verdict);
    if (!resolved) return undefined;
    return { approval: resolved, approved: verdict, remainder: named ? remainderOf(rest) : "" };
  }

  private bareAllowed(a: Approval, text: string): boolean {
    if (hasExplicitVerb(text)) return true;
    if (this.promptedToken() === a.token) return true;
    // An owner's own request may take a bare "yes" only while it is fresh: testing had a "yes" meant for
    // a new question settle an hours-old one ("Got it, that's a yes: Need the Google person's name").
    const fresh = this.now().getTime() - Date.parse(a.createdAt) < 10 * 60_000;
    return a.requestedBy === "owner" && fresh && !(a.amountUsd !== undefined && a.amountUsd > 0);
  }
}

/**
 * The policy engine is the only path to a side effect. Tool visibility is a
 * convenience; `evaluate` in `beforeToolCall` is the guard. The tier table below
 * is docs/PERMISSIONS.md in code. Keep them in step.
 */
import { randomBytes } from "node:crypto";
import type { StateDir } from "./state.js";
import type {
  Capability,
  Grant,
  Permission,
  Policy,
  PolicyDecision,
  Principal,
  SpendPolicy,
  Tier,
  ToolMeta,
} from "./types.js";

const FILE = "policy.json";

type Row = [owner: Permission, partner: Permission, family: Permission, friend: Permission, contact: Permission, stranger: Permission];

// Columns follow TIER_ORDER: owner, partner, family, friend, contact, stranger.
// "intro" and "partial" are allowed outcomes that carry a hint for the prompt.
// `web.read` (web_search, web_fetch; public hosts only, see core-tools.ts) and
// `apps.use` (Composio app tools) are transport capabilities: the specific
// capability on the same tool (calendar.freebusy, email.send, ...) does the real
// gating, so they are open for everyone the owner has placed in a tier and closed
// for contacts and strangers. Both rows appear in docs/PERMISSIONS.md.
const ROWS: Record<Capability, Row> = {
  "converse": ["yes", "yes", "yes", "yes", "yes", "intro"],
  "owner.relay": ["yes", "yes", "yes", "yes", "yes", "yes"],
  "owner.profile.public": ["yes", "yes", "yes", "yes", "yes", "no"],
  "owner.profile.preferences": ["yes", "yes", "partial", "partial", "no", "no"],
  "owner.location.exact": ["yes", "yes", "no", "no", "no", "no"],
  "owner.location.approx": ["yes", "yes", "yes", "no", "no", "no"],
  "calendar.freebusy": ["yes", "yes", "yes", "yes", "no", "no"],
  "calendar.read": ["yes", "yes", "no", "no", "no", "no"],
  "calendar.write": ["yes", "ask", "ask", "no", "no", "no"],
  "email.read": ["yes", "no", "no", "no", "no", "no"],
  "email.send": ["yes", "ask", "no", "no", "no", "no"],
  "contacts.read": ["yes", "partial", "no", "no", "no", "no"],
  "plans.propose": ["yes", "yes", "yes", "yes", "no", "no"],
  "plans.commit": ["yes", "ask", "ask", "ask", "no", "no"],
  "purchase": ["limit", "ask", "no", "no", "no", "no"],
  "travel.book": ["limit", "ask", "no", "no", "no", "no"],
  "computer.use": ["yes", "no", "no", "no", "no", "no"],
  "files.read": ["yes", "no", "no", "no", "no", "no"],
  "files.write": ["yes", "no", "no", "no", "no", "no"],
  "memory.write": ["yes", "no", "no", "no", "no", "no"],
  "network.ask": ["yes", "yes", "yes", "yes", "no", "no"],
  "network.invite": ["yes", "no", "no", "no", "no", "no"],
  "trust.manage": ["yes", "no", "no", "no", "no", "no"],
  "schedule.manage": ["yes", "no", "no", "no", "no", "no"],
  // web.read: fetch and search public web pages (never loopback, private or metadata hosts).
  "web.read": ["yes", "yes", "yes", "yes", "no", "no"],
  // apps.use: call connected app tools; each app tool also carries its own capability.
  "apps.use": ["yes", "yes", "yes", "yes", "no", "no"],
};

/** Capabilities that move money. The owner gets them under the spend policy; a grant never skips it. */
export const SPEND_CAPABILITIES: ReadonlySet<Capability> = new Set(["purchase", "travel.book"]);

const TIERS: Tier[] = ["owner", "partner", "family", "friend", "contact", "stranger"];

function buildTable(): Record<Tier, Record<Capability, Permission>> {
  const table = {} as Record<Tier, Record<Capability, Permission>>;
  TIERS.forEach((tier, i) => {
    const row = {} as Record<Capability, Permission>;
    for (const cap of Object.keys(ROWS) as Capability[]) row[cap] = ROWS[cap][i] as Permission;
    table[tier] = row;
  });
  return table;
}

export const DEFAULT_TIER_TABLE: Record<Tier, Record<Capability, Permission>> = buildTable();

export const ALL_CAPABILITIES: readonly Capability[] = Object.keys(ROWS) as Capability[];

export function defaultSpendPolicy(): SpendPolicy {
  return {
    perActionUsd: 100,
    perDayUsd: 300,
    askAbove: 50,
    neverWithoutAsk: ["flights", "hotels"],
    allowedMerchants: [],
    blockedMerchants: [],
  };
}

export function defaultPolicy(): Policy {
  return {
    version: 1,
    tiers: {},
    grants: [],
    spend: defaultSpendPolicy(),
    strangerLimits: { conversationsPerDay: 3, messagesPerConversation: 10 },
  };
}

function newId(): string {
  return `g_${randomBytes(4).toString("hex")}`;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function textOf(args: unknown): string {
  try {
    return JSON.stringify(args ?? "").toLowerCase();
  } catch {
    return "";
  }
}

const MERCHANT_KEYS = ["merchant", "merchantName", "merchant_name", "vendor", "store", "restaurant", "airline", "hotel"];

/**
 * Every merchant name in the args, lowercased. All of them are checked, so a call cannot pass
 * an allowed `merchant` while the tool actually pays the `merchantName` it was also given.
 */
function merchantsOf(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const o = args as Record<string, unknown>;
  const out: string[] = [];
  for (const k of MERCHANT_KEYS) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) out.push(v.trim().toLowerCase());
  }
  return out;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(n % 1 === 0 ? 0 : 2)}`;
}

interface CapOutcome {
  capability: Capability;
  permission: Permission;
  decision: PolicyDecision;
}

export class PolicyEngine {
  private policy: Policy;
  private readonly now: () => Date;
  private readonly spentTodayUsd: () => number;

  constructor(policy: Policy, opts: { now?: () => Date; spentTodayUsd?: () => number } = {}) {
    this.policy = clone(policy);
    this.policy.grants ??= [];
    this.policy.tiers ??= {};
    this.policy.spend = { ...defaultSpendPolicy(), ...(this.policy.spend ?? {}) };
    this.policy.strangerLimits = { ...defaultPolicy().strangerLimits, ...(this.policy.strangerLimits ?? {}) };
    this.now = opts.now ?? (() => new Date());
    this.spentTodayUsd = opts.spentTodayUsd ?? (() => 0);
  }

  /** Tier default after overrides. Every tier has every capability, so this never misses. */
  permissionFor(tier: Tier, capability: Capability): Permission {
    return this.policy.tiers[tier]?.[capability] ?? DEFAULT_TIER_TABLE[tier][capability];
  }

  private isActive(g: Grant, at: Date): boolean {
    if (g.expiresAt && Date.parse(g.expiresAt) <= at.getTime()) return false;
    const w = g.scope?.window;
    if (w) {
      // Window dates may be plain days ("2026-10-06"); treat `to` as inclusive of that day.
      if (w.from && Date.parse(w.from) > at.getTime()) return false;
      if (w.to) {
        const to = Date.parse(w.to);
        const end = /^\d{4}-\d{2}-\d{2}$/.test(w.to) ? to + 24 * 60 * 60 * 1000 : to;
        if (end <= at.getTime()) return false;
      }
    }
    return true;
  }

  private grantsFor(principal: Principal, at: Date): Grant[] {
    if (principal.cappedFrom) return [];
    const ids = new Set<string>([principal.id]);
    if (principal.contactId) ids.add(`contact:${principal.contactId}`);
    return this.policy.grants.filter((g) => ids.has(g.to) && this.isActive(g, at));
  }

  /**
   * The spend policy. `grantCapUsd` layers a grant's maxUsd on top as the ask threshold:
   * the owner's explicit "Sam can spend up to $150" replaces the owner's own askAbove, but
   * blocked merchants, never-without-ask categories, the allow list, the per-action limit
   * and the daily total still apply, and an unknown amount still asks.
   */
  private checkSpend(principal: Principal, capability: Capability, amount: number | undefined, args: unknown, label: string, grantCapUsd?: number): PolicyDecision {
    const s = this.policy.spend;
    const asker = principal.kind === "owner" ? "" : `${principal.displayName} asks: `;
    const ask = (reason: string): PolicyDecision => ({
      outcome: "ask",
      reason,
      approvalPrompt: `${asker}${label}${amount !== undefined ? ` (${fmtUsd(amount)})` : ""}? Reply YES or NO.`,
    });
    const merchants = merchantsOf(args);
    const blocked = merchants.find((name) => s.blockedMerchants.some((m) => name.includes(m.toLowerCase())));
    if (blocked) return { outcome: "deny", reason: `${blocked} is on the blocked merchant list` };
    if (amount === undefined) return ask(`${capability}: amount unknown, owner must confirm`);
    const haystack = textOf(args);
    const flagged = s.neverWithoutAsk.find((w) => haystack.includes(w.toLowerCase()));
    if (flagged) return ask(`${flagged} always needs the owner's confirmation`);
    if (s.allowedMerchants.length > 0) {
      const off = merchants.length === 0 ? "" : merchants.find((name) => !s.allowedMerchants.some((m) => name.includes(m.toLowerCase())));
      if (off !== undefined) return ask(`merchant${off ? ` ${off}` : ""} is not on the allowed list`);
    }
    if (amount > s.perActionUsd) return ask(`${fmtUsd(amount)} is above the per-action limit of ${fmtUsd(s.perActionUsd)}`);
    const askAbove = grantCapUsd ?? s.askAbove;
    if (amount > askAbove) return ask(`${fmtUsd(amount)} is above the ${grantCapUsd !== undefined ? "grant cap" : "ask threshold"} of ${fmtUsd(askAbove)}`);
    const spent = this.spentTodayUsd();
    if (spent + amount > s.perDayUsd) {
      return ask(`${fmtUsd(amount)} would take today's total to ${fmtUsd(spent + amount)}, above the daily limit of ${fmtUsd(s.perDayUsd)}`);
    }
    return { outcome: "allow", reason: `${fmtUsd(amount)} is within the ${grantCapUsd !== undefined ? "grant and the" : `${principal.tier}`} spend policy` };
  }

  private evaluateOne(principal: Principal, capability: Capability, meta: ToolMeta, args: unknown, at: Date): CapOutcome {
    const permission = this.permissionFor(principal.tier, capability);
    const amount = meta.amountUsd?.(args);
    const label = meta.describe?.(args) ?? `${principal.displayName} wants ${capability}`;
    const askDecision: PolicyDecision = {
      outcome: "ask",
      reason: `${capability} requires the owner's approval for tier ${principal.tier}`,
      approvalPrompt: `${principal.displayName} asks: ${label}${amount !== undefined ? ` (${fmtUsd(amount)})` : ""}. Reply YES or NO.`,
    };

    // A blocked merchant is blocked for everyone; no tier, grant or approval opens it.
    if (SPEND_CAPABILITIES.has(capability) && permission !== "no") {
      const blocked = merchantsOf(args).find((name) => this.policy.spend.blockedMerchants.some((m) => name.includes(m.toLowerCase())));
      if (blocked) {
        return { capability, permission, decision: { outcome: "deny", reason: `${blocked} is on the blocked merchant list` } };
      }
    }

    if (permission === "no" || permission === "ask") {
      const grant = this.grantsFor(principal, at).find((g) => g.capabilities.includes(capability));
      if (grant) {
        const max = grant.scope?.maxUsd;
        const covered = max === undefined || amount === undefined || amount <= max;
        if (covered && SPEND_CAPABILITIES.has(capability)) {
          // A grant to spend is still spending: run the owner's spend policy with the grant
          // cap as the ask threshold, so blocked merchants, flights and the daily total hold.
          const decision = this.checkSpend(principal, capability, amount, args, label, max);
          if (decision.outcome === "allow") decision.viaGrant = grant.id;
          return { capability, permission, decision };
        }
        if (covered) {
          return {
            capability,
            permission,
            decision: { outcome: "allow", reason: `grant ${grant.id}${grant.note ? ` (${grant.note})` : ""} covers ${capability}`, viaGrant: grant.id },
          };
        }
        // The grant exists but the amount is over its cap: fall through to the tier default.
        const over = `${fmtUsd(amount ?? 0)} exceeds grant ${grant.id} cap of ${fmtUsd(max ?? 0)}`;
        if (permission === "ask") {
          return { capability, permission, decision: { ...askDecision, reason: over } };
        }
        return { capability, permission, decision: { outcome: "deny", reason: `${over} and tier ${principal.tier} has no ${capability}` } };
      }
      if (permission === "ask") return { capability, permission, decision: askDecision };
      return { capability, permission, decision: { outcome: "deny", reason: `tier ${principal.tier} may not ${capability}` } };
    }

    if (permission === "limit") {
      return { capability, permission, decision: this.checkSpend(principal, capability, amount, args, label) };
    }

    if (permission === "intro") {
      return { capability, permission, decision: { outcome: "allow", reason: `${capability} allowed as a short introduction only (tier ${principal.tier})` } };
    }
    if (permission === "partial") {
      return { capability, permission, decision: { outcome: "allow", reason: `${capability} allowed in part for tier ${principal.tier}; share only what the tier may see` } };
    }
    return { capability, permission, decision: { outcome: "allow", reason: `tier ${principal.tier} may ${capability}` } };
  }

  /** All capabilities must pass. Deny beats ask beats allow. */
  evaluate(principal: Principal, meta: ToolMeta, args: unknown): PolicyDecision {
    const at = this.now();
    if (meta.capabilities.length === 0) return { outcome: "allow", reason: "tool declares no capabilities" };
    const outcomes = meta.capabilities.map((c) => this.evaluateOne(principal, c, meta, args, at));

    const denied = outcomes.find((o) => o.decision.outcome === "deny");
    if (denied) return denied.decision;

    const asks = outcomes.filter((o) => o.decision.outcome === "ask");
    if (asks.length > 0) {
      const first = asks[0]!.decision as Extract<PolicyDecision, { outcome: "ask" }>;
      return {
        outcome: "ask",
        reason: asks.map((o) => o.decision.reason).join("; "),
        approvalPrompt: first.approvalPrompt,
      };
    }

    const viaGrant = outcomes.map((o) => (o.decision.outcome === "allow" ? o.decision.viaGrant : undefined)).find(Boolean);
    const decision: PolicyDecision = { outcome: "allow", reason: outcomes.map((o) => o.decision.reason).join("; ") };
    if (viaGrant) decision.viaGrant = viaGrant;
    return decision;
  }

  /** Used to hide tools: false only when the tier default is "no" and no active grant covers it. */
  canEver(principal: Principal, capability: Capability): boolean {
    if (this.permissionFor(principal.tier, capability) !== "no") return true;
    return this.grantsFor(principal, this.now()).some((g) => g.capabilities.includes(capability));
  }

  addGrant(g: Omit<Grant, "id" | "createdAt">): Grant {
    const grant: Grant = { ...clone(g), id: newId(), createdAt: this.now().toISOString() };
    this.policy.grants.push(grant);
    return clone(grant);
  }

  revokeGrant(id: string): boolean {
    const before = this.policy.grants.length;
    this.policy.grants = this.policy.grants.filter((g) => g.id !== id);
    return this.policy.grants.length !== before;
  }

  listGrants(to?: string): Grant[] {
    const at = this.now();
    return this.policy.grants.filter((g) => (to === undefined || g.to === to) && this.isActive(g, at)).map(clone);
  }

  setTierOverride(tier: Tier, capability: Capability, permission: Permission): void {
    const row = (this.policy.tiers[tier] ??= {});
    if (permission === DEFAULT_TIER_TABLE[tier][capability]) {
      delete row[capability];
      if (Object.keys(row).length === 0) delete this.policy.tiers[tier];
      return;
    }
    row[capability] = permission;
  }

  get spend(): SpendPolicy {
    return clone(this.policy.spend);
  }

  get strangerLimits(): Policy["strangerLimits"] {
    return clone(this.policy.strangerLimits);
  }

  toJSON(): Policy {
    return clone(this.policy);
  }
}

export function loadPolicy(state: StateDir): Policy {
  const raw = state.readJson<Partial<Policy>>(FILE, {});
  const d = defaultPolicy();
  return {
    version: 1,
    tiers: raw.tiers ?? d.tiers,
    grants: Array.isArray(raw.grants) ? raw.grants : d.grants,
    spend: { ...d.spend, ...(raw.spend ?? {}) },
    strangerLimits: { ...d.strangerLimits, ...(raw.strangerLimits ?? {}) },
  };
}

export function savePolicy(state: StateDir, policy: Policy): void {
  state.writeJson(FILE, policy);
}

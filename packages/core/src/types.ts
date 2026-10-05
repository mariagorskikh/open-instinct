/**
 * Shared types for Open Instinct. Every package builds against these.
 * Keep this file dependency-free (no runtime imports).
 */

// ---------------------------------------------------------------------------
// Principals and trust
// ---------------------------------------------------------------------------

/** Who is talking to the agent. Resolved before the model sees a message. */
export type PrincipalKind = "owner" | "contact" | "agent" | "stranger";

/** Trust tiers, highest first. See docs/PERMISSIONS.md. */
export type Tier = "owner" | "partner" | "family" | "friend" | "contact" | "stranger";

export const TIER_ORDER: readonly Tier[] = ["owner", "partner", "family", "friend", "contact", "stranger"];

export interface Principal {
  kind: PrincipalKind;
  /** Stable id: `owner`, `contact:<contactId>`, `agent:<handle>`, `stranger:<channel>:<address>` */
  id: string;
  tier: Tier;
  displayName: string;
  /** Channel addresses we know for this principal. */
  phone?: string;
  email?: string;
  /** Inkbox agent handle when the principal is (or acts through) an agent. */
  agentHandle?: string;
  /** Contact id in contacts.json when known. */
  contactId?: string;
  /** For `agent` principals: the human the agent acts for, when known. */
  onBehalfOf?: { displayName: string; contactId?: string };
  /**
   * Set when a higher-trust principal speaks in a shared thread (an iMessage group) and
   * therefore acts at a lower tier than its own, because every reply is visible to all.
   */
  cappedFrom?: Tier;
}

/** Capability strings. The table of defaults lives in policy.ts. */
export type Capability =
  | "converse"
  | "owner.relay"
  | "owner.profile.public"
  | "owner.profile.preferences"
  | "owner.location.exact"
  | "owner.location.approx"
  | "calendar.freebusy"
  | "calendar.read"
  | "calendar.write"
  | "email.read"
  | "email.send"
  | "contacts.read"
  | "plans.propose"
  | "plans.commit"
  | "purchase"
  | "travel.book"
  | "computer.use"
  | "files.read"
  | "files.write"
  | "memory.write"
  | "network.ask"
  | "network.invite"
  | "trust.manage"
  | "schedule.manage"
  | "web.read"
  | "apps.use";

/** What a tier gets for a capability by default. */
export type Permission = "yes" | "ask" | "limit" | "no" | "intro" | "partial";

export interface Grant {
  id: string;
  /** Principal id the grant applies to (e.g. `contact:sam`). */
  to: string;
  capabilities: Capability[];
  scope?: {
    purpose?: string;
    window?: { from: string; to: string };
    maxUsd?: number;
    [k: string]: unknown;
  };
  /** ISO timestamp. */
  expiresAt?: string;
  note?: string;
  createdAt: string;
}

export interface SpendPolicy {
  perActionUsd: number;
  perDayUsd: number;
  askAbove: number;
  neverWithoutAsk: string[];
  allowedMerchants: string[];
  blockedMerchants: string[];
}

export interface Policy {
  version: 1;
  /** Overrides of the default tier table: tier -> capability -> permission. */
  tiers: Partial<Record<Tier, Partial<Record<Capability, Permission>>>>;
  grants: Grant[];
  spend: SpendPolicy;
  strangerLimits: { conversationsPerDay: number; messagesPerConversation: number };
}

export type PolicyDecision =
  | { outcome: "allow"; reason: string; viaGrant?: string }
  | { outcome: "ask"; reason: string; approvalPrompt: string }
  | { outcome: "deny"; reason: string };

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface Contact {
  id: string;
  name: string;
  tier: Tier;
  phones: string[];
  emails: string[];
  /** Inkbox handle of this person's agent, if they have one. */
  agentHandle?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Channels and events
// ---------------------------------------------------------------------------

export type Channel = "imessage" | "sms" | "email" | "a2a" | "chat" | "scheduled" | "system";

/** A normalized inbound event, whatever the source. */
export interface InboundMessage {
  /** Stable id for dedupe (webhook event id, or generated). */
  id: string;
  channel: Channel;
  /** Conversation key, e.g. `imessage:<conversation_id>`. */
  conversationKey: string;
  /** Raw sender address: E.164, email, agent handle, or `owner` for dashboard chat. */
  from: string;
  text: string;
  attachments?: Array<{ url?: string; path?: string; mimeType?: string; name?: string }>;
  /** Channel-specific ids needed to reply (Inkbox conversation id, message id, A2A task id, ...). */
  replyRef: Record<string, string | undefined>;
  /** For A2A: the structured OIP part if present. */
  data?: Record<string, unknown>;
  receivedAt: string;
  /** Source as Maritime reports it: front_door, cli, telegram, webhook, scheduled. */
  source?: string;
  /** Any extra metadata from the channel. */
  meta?: Record<string, unknown>;
}

export interface OutboundMessage {
  channel: Exclude<Channel, "scheduled" | "system">;
  /** Reply in a conversation (preferred) or start a new one. */
  conversationKey?: string;
  to?: string | string[];
  text: string;
  mediaUrls?: string[];
  replyToMessageId?: string;
  /** iMessage expressive effect. */
  sendStyle?: string;
  /** For A2A replies. */
  a2a?: { taskId: string; intent: "progress" | "complete" | "ask_caller" | "fail"; data?: Record<string, unknown> };
  /**
   * The inbound message's replyRef, copied by the runtime so a channel adapter can thread
   * an email reply (Message-ID, subject, mailbox) or address an A2A task (taskId, contextId).
   */
  replyRef?: Record<string, string | undefined>;
}

/** The envelope the gateway wraps Inkbox events in when relaying through Maritime /chat. */
export const EVENT_ENVELOPE_PREFIX = "@@instinct-event@@";

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export interface ScheduleEntry {
  id: string;
  name?: string;
  enabled: boolean;
  /** 5-field cron in `tz`, or omit and use `nextRunAt` for one-shot. */
  cron?: string;
  tz?: string;
  /** ISO timestamp of the next occurrence; recomputed after each run. */
  nextRunAt?: string;
  /** Prompt delivered to the owner conversation when the job fires. */
  prompt: string;
  createdAt: string;
  lastRunAt?: string;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditKind =
  | "inbound"
  | "outbound"
  | "tool_call"
  | "tool_result"
  | "policy"
  | "approval"
  | "spend"
  | "schedule"
  | "error";

export interface AuditEntry {
  at: string;
  kind: AuditKind;
  conversationKey?: string;
  principal?: string;
  detail: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OwnerProfile {
  name: string;
  phones: string[];
  emails: string[];
  timezone: string;
  city?: string;
  /** Free-form facts the owner wants the agent to know, shown to the owner only. */
  about?: string;
}

export interface InstinctConfig {
  version: 1;
  owner: OwnerProfile;
  agent: { name: string; handle?: string; persona?: string };
  model: { primary: string; fallback?: string; cheap?: string; thinking?: "off" | "minimal" | "low" | "medium" | "high" };
  computer: { mode: "auto" | "desktopd" | "maritime" | "none"; desktopdUrl?: string; maritimeMcpUrl?: string };
  apps: { enabled: boolean; toolkits: string[] };
  features: { typingIndicators: boolean; tapbacks: boolean; journal: boolean };
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface Approval {
  token: string;
  conversationKey: string;
  requestedBy: string;
  summary: string;
  capability: Capability;
  amountUsd?: number;
  /** The tool the approval was raised for, when the policy guard raised it. */
  toolName?: string;
  /** Stable hash of the normalized tool arguments, so an approval covers one exact call. */
  argsHash?: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired";
}

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

/** Side-channel metadata attached to every Pi tool we register. */
export interface ToolMeta {
  /** Capabilities a call needs; all must be allowed. */
  capabilities: Capability[];
  /** Group used for prompt sections and filtering. */
  group: "messaging" | "owner" | "memory" | "contacts" | "network" | "schedule" | "files" | "computer" | "apps" | "web" | "system";
  /** Extract a USD amount from the args for spend checks, if applicable. */
  amountUsd?: (args: unknown) => number | undefined;
  /**
   * The tool writes any "spend" audit entries itself, so the runtime skips its generic one.
   * Set it on tools that carry the purchase capability but move no money on their own call
   * (status checks, listings), which would otherwise log empty spend entries.
   */
  recordsOwnSpend?: boolean;
  /** Short human description for the audit log. */
  describe?: (args: unknown) => string;
}

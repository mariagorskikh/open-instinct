/**
 * The agent runtime: one Pi Agent per conversation, the policy guard in beforeToolCall,
 * approvals, audit, session persistence, and the fast-ack / deliver-later behaviour the
 * 30 second /chat budget demands.
 *
 * Two keys matter here. The channel's conversation key (`imessage:<id>`) is where replies
 * go. The runtime key is which Agent and transcript handles the message. They are the same
 * for a 1:1 thread; in a group thread every participant gets a runtime key of their own, so a
 * stranger in the group never sees what the owner's turns put in context.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Agent, type AgentMessage, type AgentTool, type BeforeToolCallResult, type StreamFn } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration, type ImageContent, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { BUDGET_EXHAUSTED_PATTERN, budgetExhaustedReply } from "./budget.js";
import type { ApprovalMatch, ApprovalStore } from "./approvals.js";
import type { AuditLog } from "./audit.js";
import type { ContactStore } from "./contacts.js";
import type { MemoryStore } from "./memory.js";
import { busySection, meetingsSection, type MeetingStore } from "./meetings.js";
import { OwnerNotifier } from "./notifier.js";
import { DEFAULT_TIER_TABLE, SPEND_CAPABILITIES, type PolicyEngine } from "./policy.js";
import { looksLikePhone, normalizePhone, resolvePrincipal } from "./principal.js";
import { saveConfig } from "./config.js";
import { CLAIM_WELCOME_TEXT, MAX_CLAIM_ATTEMPTS, matchClaimCode, ownerClaimStatus } from "./owner-claim.js";
import { readAgentsInstructions, readPersona } from "./persona.js";
import { buildSystemPrompt, wrapUntrusted } from "./prompt.js";
import { A2AStore, a2aState, a2aTerminal, type A2ADelegation } from "./a2a-state.js";
import { mayShareOwnerContact, ownerContactIn } from "./privacy.js";
import type { Scheduler } from "./scheduler.js";
import type { StateDir } from "./state.js";
import type { RegisteredTool, ToolContext, ToolRegistry } from "./tools.js";
import {
  TIER_ORDER,
  type Approval,
  type Capability,
  type Channel,
  type InboundMessage,
  type InstinctConfig,
  type OutboundMessage,
  type Principal,
  type ScheduleEntry,
  type Tier,
  type ToolMeta,
} from "./types.js";

export interface Outbox {
  send(msg: OutboundMessage, ctx: { principal: Principal; conversationKey: string }): Promise<void>;
  typing?(conversationKey: string): Promise<void>;
}

export interface RuntimeDeps {
  state: StateDir;
  /** false disables the five-minute housekeeping timer (quiet-hours flush, stale-ask nudges). Tests. */
  housekeeping?: boolean;
  config: InstinctConfig;
  policy: PolicyEngine;
  approvals: ApprovalStore;
  audit: AuditLog;
  scheduler: Scheduler;
  contacts: ContactStore;
  memory: MemoryStore;
  /** The owner's agreed meetings; shown on every turn so no one re-proposes or double-books them. */
  meetings?: MeetingStore;
  registry: ToolRegistry;
  model: Model<any>;
  outbox: Outbox;
  /**
   * The skills section, or a function that rebuilds it on each prompt for the conversation's
   * principal, so skills installed at runtime appear on the next turn and private skills are
   * listed only to whoever may load them.
   */
  skillsPrompt?: string | ((principal: Principal) => string | undefined);
  streamFn?: StreamFn;
  now?: () => Date;
  replyBudgetMs?: number;
  /** A run older than this is aborted when the next message arrives (default 15 minutes). */
  maxRunMs?: number;
  /** Owner texts that arrive within this many ms (replies from several agents, a burst of updates) go out as one message. 0 sends at once. */
  ownerMergeMs?: number;
  sessionsDir?: string;
  /** API key lookup handed to Pi; needed for "openai-compatible/..." models. Core never reads env. */
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  /** Render a structured data part (an OIP message) for the model. Core falls back to fenced JSON. */
  describeData?: (data: Record<string, unknown>) => string | undefined;
  /** Extra system prompt sections per principal and channel, for example the network guidance. */
  promptExtra?: (principal: Principal, channel: Channel) => string[];
  /** "What is set up right now", read fresh for every prompt build. */
  setupSummary?: () => string | undefined;
  a2aStore?: A2AStore;
  loadA2ATask?: (taskId: string) => Promise<unknown>;
}

export interface HandleResult {
  acked: boolean;
  reply?: string;
  principal: Principal;
  conversationKey: string;
  blocked?: string;
}

/** Messages kept verbatim in context; older ones are folded into one summary message. */
export const SESSION_KEEP_MESSAGES = 60;
/** Characters of kept transcript (JSON) before older turns are folded even if the count is under the limit. */
export const SESSION_KEEP_CHARS = 240_000;
/** How many of the newest image-bearing tool results keep their pictures through a fold. */
export const KEEP_RECENT_IMAGES = 2;
/** An approved request can be acted on for this long before it lapses. */
export const APPROVAL_USE_WINDOW_MS = 15 * 60 * 1000;
const SEEN_IDS_MAX = 500;
const DEFAULT_REPLY_BUDGET_MS = 20_000;
/** A run older than this is treated as stuck when the next message arrives. Long browser work fits well inside it. */
const DEFAULT_MAX_RUN_MS = 15 * 60_000;
const TYPING_TIMEOUT_MS = 2_000;
const SEEN_FILE = "seen-ids.json";
const STRANGERS_FILE = "strangers.json";
const CONVERSATIONS_FILE = "conversations.json";
const APPROVED_FILE = "approved.json";
const PENDING_REPLIES_FILE = "pending-replies.json";
const DELIVERABLE: ReadonlySet<Channel> = new Set(["imessage", "sms", "email", "a2a"]);
/** Channels where the sender's identity is bound to the carrier or the process, so an owner reply can settle an approval. */
const APPROVAL_CHANNELS: ReadonlySet<Channel> = new Set(["imessage", "sms", "chat"]);
const CHANNELS: ReadonlySet<string> = new Set(["imessage", "sms", "email", "a2a", "chat", "scheduled", "system"]);
const REPLY_TOOL = "reply_instinct";
const PROCESSING_FILE = "processing-events.json";
const CLAIM_ATTEMPTS_FILE = "owner-claim-attempts.json";
const CARRIER_CHANNELS: ReadonlySet<Channel> = new Set(["imessage", "sms"]);
interface OwnerQueue {
  texts: string[];
  principal: Principal;
  originKey: string;
  approvalToken?: string;
  done: Promise<void>;
}

/** An owner's ask that proposes meeting someone (as opposed to a note, a question or a share). */
const MEETING_ASK = /\b(meet|meetup|coffee|lunch|dinner|intro|introduce|catch up|chat|slot|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i;

/** An agent's message that is really for the owner: a heads-up, a question about them, a detail they sent. */
const OWNER_NOTE = /\b(running (?:\d+ (?:min(?:ute)?s? )?)?late|running behind|minutes late|min late|on (?:my|their|his|her) way|heads[- ]up|what (?:is|are|does|do) (?:\w+ )?(?:working on|building|doing)|working on|here(?:'s| is) (?:my|their|his|her) (?:email|phone|number|linkedin)|@[\w.-]+\.[a-z]{2,}|linkedin\.com|thank(?:s| you))\b/i;

/** Tools whose success means a message reached someone other than the owner. */
const SEND_TOOLS = new Set(["ask_instinct", "send_message", "reply_instinct", "send_file", "invite", "invite_to_network", "phone_call"]);
/** OpenAI-compatible proxies reject more tools than this in one request. */
export const MAX_MODEL_TOOLS = 128;
/** Inbound agent-to-agent messages from one peer above this many per hour are dropped unread. */
export const A2A_PEER_HOURLY_LIMIT = 30;
/** Owner texts that are not replies to the owner wait out these local hours (start inclusive, end exclusive). */
export const QUIET_HOURS = { start: 22, end: 8 };
/** An owner who texted this recently is awake; quiet hours do not hold texts for them. */
const OWNER_AWAKE_MS = 15 * 60_000;
const QUIET_HOLD_FILE = "quiet-hold.json";
/** An owner's ask to another agent with no answer after this long gets one nudge. */
export const STALE_ASK_MS = 2 * 60 * 60_000;
const NUDGED_FILE = "a2a-nudged.json";
/** An owner message this long after the previous one in the thread is answered as a fresh start. */
const GAP_NOTE_MS = 3 * 60 * 60_000;
const LAST_OWNER_TURN_FILE = "last-owner-turn.json";



/** Work may already have caused an external effect; automatic replay is not safe. */
export class InboundUncertainError extends Error {
  constructor(readonly eventId: string, cause?: unknown) {
    super(`Inbound event ${eventId} requires recovery before replay`, { cause });
    this.name = "InboundUncertainError";
  }
}

class A2AInactiveError extends Error {}

type OutboundChannel = OutboundMessage["channel"];
type ReplyRef = Record<string, string | undefined>;

interface StrangerDay {
  conversations: Record<string, number>;
  relays: number;
}

/** What conversations.json remembers per runtime key, so a restart can still resume and deliver. */
interface ConversationRecord {
  principal: Principal;
  deliveryKey: string;
  replyRef?: ReplyRef;
}

/** An approval the owner said yes to, waiting for the exact call to be retried. */
interface ApprovedRecord extends Approval {
  approvedAt: string;
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

interface ConversationOptions {
  key: string;
  deliveryKey: string;
  principal: Principal;
  channel: Channel;
  agent: Agent;
  sessionFile: string;
  replyRef: ReplyRef;
  refreshPrompt: () => string;
  now: () => Date;
}

/**
 * Some models leak their tool-call channel into the text ("to=functions.load_skill commentary
 * {...}", "<|channel|>"), sometimes followed by junk tokens. Nothing from that point on is meant
 * for the owner.
 */
export function stripModelArtifacts(text: string): string {
  const m = /(\bto=functions\.|<\|(?:channel|message|start|end|call|constrain)\|>|\bassistant to=|\bcommentary\s*\{")/i.exec(text);
  const cut = m ? text.slice(0, m.index).trimEnd() : text;
  // Memory markup such as <PRIVATE>...</PRIVATE> is for the model, never the owner.
  return cut
    // Network plumbing the model copies from inbound A2A text: "<handle> via Instinct:", "(from <handle>)",
    // approval tokens. None of it means anything to a person reading a text.
    .replace(/\b[a-z0-9][a-z0-9-]{2,} via Instinct:\s*/gi, "")
    .replace(/\s*\(from [a-z0-9][a-z0-9-]{2,}(?:'s agent)?\)/gi, "")
    .replace(/\s*Reply YES or NO\.?(?:\s*Token\s+\w+\.?)?/g, "")
    .replace(/<(PRIVATE|INTERNAL|NOTES?)>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(PRIVATE|INTERNAL|NOTES?)>/gi, "")
    // An error page pasted from a failed fetch ("Hit a snag (<!DOCTYPE html>)") means nothing to the owner.
    .replace(/<html[\s\S]*?<\/html>/gi, "")
    .replace(/\s*\(?<!DOCTYPE[^)\n]*\)?/gi, "")
    // Template placeholders in a draft ("[your link]", "[Name]") would be sent as typed.
    // A label goes with its placeholder ("Here's my LinkedIn: <your link>").
    .replace(/[ \t]*(?:[\w'’ ]{0,30}:[ \t]*)?<(?:your|insert|their)\b[^>\n]{0,40}>/gi, "")
    .replace(/[ \t]*(?:[\w'’ ]{0,30}:[ \t]*)?(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/(?:your|my|insert)[-\w]*\/?/gi, "")
    .replace(/[ \t]*\[(?:your|insert|their|add|name|link|company|role|title|date|time|number|phone|email|question|exact|venue)\b[^\]\n]{0,40}\](?!\()/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Links only a tool can mint: connect and sign-in pages, app-platform domains, placeholders. */
const MINTED_LINK_HOSTS = /(^|\.)(composio\.dev|example\.com)$|\.invalid$/i;
const MINTED_LINK_PATHS = /\/(connect|oauth|link|auth|authorize|login)(\/|$|\?)/i;
const MARITIME_APP_PATHS = /^\/(apps?|connect|dashboard)(\/|$)/i;
const URL_IN_TEXT = /https?:\/\/[^\s<>()\]"']+/g;

/** A URL reduced to what matters for "have we seen this link": host without www, path without trailing slash, query. */
function linkKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * Keep only links the owner can trust. A model asked for a connect link or a source it does
 * not have will type one. A connect or sign-in link must come from a tool result (`sources`);
 * any other link must appear in a tool result or in `context` (the agent's instructions and
 * the owner's own messages). A missing connect link becomes a plain admission; any other
 * unverified link is dropped, with a "Source:" label it leaves dangling.
 */
export function scrubUnverifiedLinks(text: string, sources: string, context = ""): string {
  // A bare "linkedin.com/in/..." is checked like any link; models build these from a name.
  const bareLinkedIn = /(^|[\s(:"])((?:www\.)?linkedin\.com\/in\/[\w%-]+\/?)/gi;
  text = stripModelArtifacts(text).replace(bareLinkedIn, "$1https://$2");
  sources = sources.replace(bareLinkedIn, "$1https://$2");
  context = context.replace(bareLinkedIn, "$1https://$2");
  const fromTools = new Set((sources.match(URL_IN_TEXT) ?? []).map((u) => linkKey(u.replace(/[.,;:!?]+$/, ""))));
  const contextUrls = (context.match(URL_IN_TEXT) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));
  const known = new Set([...fromTools, ...contextUrls.map(linkKey)]);
  const knownFolders = new Set(contextUrls.filter((u) => /\/$/.test(u) && linkKey(u).includes("/")).map((u) => `${linkKey(u)}/`));
  const out = text.replace(URL_IN_TEXT, (url) => {
    const clean = url.replace(/[.,;:!?]+$/, "");
    const tail = url.slice(clean.length);
    let host = "", pathname = "";
    try {
      const u = new URL(clean);
      host = u.hostname;
      pathname = u.pathname;
    } catch {
      return url;
    }
    const key = linkKey(clean);
    const minted = MINTED_LINK_HOSTS.test(host) || MINTED_LINK_PATHS.test(pathname) || (/(^|\.)maritime\.sh$/i.test(host) && MARITIME_APP_PATHS.test(pathname));
    if (minted) return fromTools.has(key) || sources.includes(clean) ? url : "\u0000" + tail;
    if (known.has(key) || sources.includes(clean) || context.includes(clean)) return url;
    // A page under a folder the instructions name (".../people/<first-last>" arrives as ".../people/").
    return [...knownFolders].some((f) => key.startsWith(f)) ? url : "\u0000" + tail;
  });
  if (!out.includes("\u0000")) return out;
  const lines: string[] = [];
  for (const raw of out.split("\n")) {
    if (!raw.includes("\u0000")) {
      lines.push(raw);
      continue;
    }
    // A sentence built around the dropped link ("block them once you connect here: <link>") is
    // half a sentence without it, so it goes whole, unless it still carries another link (a list of sources).
    const sentences = raw.split(/(?<=[.!?])\s+/);
    const line = sentences.filter((s) => !s.includes("\u0000") || /https?:\/\//.test(s)).join(" ");
    if (!line.includes("\u0000")) {
      if (/[\p{L}\p{N}]/u.test(line)) lines.push(line.trimEnd());
      else dropDanglingLabel(lines);
      continue;
    }
    const tidy = line
      .replace(/\b(sources?|links?|more|see|via|connect[^:]{0,40})\s*:\s*\u0000/gi, "\u0000")
      .replace(/\s*(,|\band\b|\bor\b)\s*\u0000/gi, "\u0000")
      .replace(/\u0000\s*(,|\band\b|\bor\b)\s*/gi, "\u0000")
      .replace(/\s*\(\s*\u0000\s*\)/g, "")
      .replace(/\s*\u0000/g, "")
      .replace(/\s+([.,;:!?])/g, "$1")
      .trimEnd();
    // A line that held only the link, or a label whose link is gone, says nothing now.
    if (/[\p{L}\p{N}]/u.test(tidy) && !/[:：]$/.test(tidy.trim())) lines.push(tidy);
    else dropDanglingLabel(lines);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The link a line led into is gone, so the line above that announced it ("Source:", "Connect
 * Calendar so I can block them:") points at nothing: drop a bare label, or the trailing clause
 * that ends in the colon.
 */
function dropDanglingLabel(lines: string[]): void {
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const last = lines[lines.length - 1];
  if (last === undefined || !/[:：]\s*$/.test(last)) return;
  const sentences = last.trimEnd().split(/(?<=[.!?。])\s+/);
  sentences.pop();
  if (sentences.length === 0) lines.pop();
  else lines[lines.length - 1] = sentences.join(" ");
}

export class Conversation {
  /** Runtime key: which Agent and transcript. */
  readonly key: string;
  /** Channel key: where replies are delivered. Same as `key` except in shared threads. */
  readonly deliveryKey: string;
  principal: Principal;
  readonly agent: Agent;
  readonly channel: Channel;
  /** Channel ids of the latest inbound message (email Message-ID, A2A task id, ...). */
  replyRef: ReplyRef;
  /** Set when the model answered an A2A task itself during the current run. */
  repliedViaTool = false;
  /** True while the current run was started by the owner's own direct message (see ToolContext.ownerTurn). */
  ownerTurn = false;
  /** A tool that reaches someone else (ask_instinct, send_message, reply_instinct) succeeded in the current run. */
  sentThisRun = false;
  /** notify_owner or ask_owner succeeded in the current run. */
  relayedThisRun = false;
  /** Text of the last tool results, the only place a link the owner can act on can come from. */
  recentToolText(limit = 80): string {
    const parts: string[] = [];
    for (const m of this.agent.state.messages.slice(-limit)) {
      if (m.role !== "toolResult") continue;
      for (const c of m.content) if (c.type === "text") parts.push(c.text);
    }
    for (const link of this.links) parts.push(link);
    return parts.join("\n");
  }
  /** Text whose links the owner can trust besides tool results: the agent's instructions and the owner's own messages. */
  knownText(): string {
    const parts = [this.agent.state.systemPrompt ?? ""];
    for (const m of this.agent.state.messages) if (m.role === "user") parts.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    return parts.join("\n");
  }
  /** Every link a tool result produced in this thread. The fold drops old results; this does not. */
  readonly links = new Set<string>();
  busy = false;
  private readonly sessionFile: string;
  private readonly refreshPrompt: () => string;
  private readonly now: () => Date;

  constructor(opts: ConversationOptions) {
    this.key = opts.key;
    this.deliveryKey = opts.deliveryKey;
    this.principal = opts.principal;
    this.channel = opts.channel;
    this.agent = opts.agent;
    this.sessionFile = opts.sessionFile;
    this.replyRef = opts.replyRef;
    this.refreshPrompt = opts.refreshPrompt;
    this.now = opts.now;
  }

  /** Prompt the agent, wait until it is idle, and return the final assistant text. */
  async run(text: string, images?: ImageContent[]): Promise<string> {
    if (this.busy) throw new Error(`Conversation ${this.key} is busy; use steer() or followUp()`);
    this.busy = true;
    this.busySince = this.now().getTime();
    this.repliedViaTool = false;
    this.sentThisRun = false;
    this.relayedThisRun = false;
    this.fileFences = [];
    const current = this.runOnce(text, images);
    this.current = current.then(() => undefined, () => undefined);
    return current;
  }

  /** When the current run started (ms), or undefined when idle. */
  busySince: number | undefined;
  /** The tool the current run last started, for a status line while it is busy. */
  activity: string | undefined;
  /** Dashboard file blocks a tool produced this run; the reply must carry them or the file never arrives. */
  fileFences: string[] = [];
  private current: Promise<void> = Promise.resolve();

  /**
   * A run that never ends (a tool that hangs, a stuck model call) would answer every later
   * message with "on it" forever. Abort a run older than `maxMs` and wait briefly for it to
   * unwind; returns true when it did.
   */
  async abortIfStuck(maxMs: number): Promise<boolean> {
    if (!this.busy || this.busySince === undefined || this.now().getTime() - this.busySince < maxMs) return false;
    this.agent.abort();
    await Promise.race([this.current, new Promise((r) => setTimeout(r, 2000))]);
    this.busy = false;
    this.busySince = undefined;
    return true;
  }

  private async runOnce(text: string, images?: ImageContent[]): Promise<string> {
    try {
      this.applySystemPrompt();
      // The transcript grows between restarts too, so the fold runs before every turn.
      this.agent.state.messages = trimContext(this.agent.state.messages, this.now());
      const before = this.agent.state.messages.length;
      await this.agent.prompt(text, images);
      await this.agent.waitForIdle();
      const fresh = this.agent.state.messages.slice(before);
      this.persist();
      const failure = runFailure(fresh);
      if (failure) throw new Error(failure);
      return finalAssistantText(fresh);
    } finally {
      this.busy = false;
      this.busySince = undefined;
      this.activity = undefined;
    }
  }

  steer(text: string): void {
    this.agent.steer(userMessage(text, this.now()));
  }

  followUp(text: string): void {
    this.agent.followUp(userMessage(text, this.now()));
  }

  /** Write the transcript (without system messages, which are rebuilt) as JSON lines. */
  persist(): void {
    writeSession(this.sessionFile, this.agent.state.messages);
  }

  /** The prompt carries the date, memory and pending approvals, so it is rebuilt per run. */
  private applySystemPrompt(): void {
    const prompt = this.refreshPrompt();
    const tools = this.agent.state.tools.map(toToolDeclaration);
    const system = createInitialSystemMessage(prompt, tools);
    const rest = this.agent.state.messages.filter((m) => m.role !== "system");
    this.agent.state.messages = system ? [system, ...rest] : rest;
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

interface ConversationOpts {
  deliveryKey?: string;
  replyRef?: ReplyRef;
}

export class AgentRuntime {
  private readonly deps: RuntimeDeps;
  private readonly conversations = new Map<string, Conversation>();
  /**
   * The last bubble sent into each carrier thread, stamped with a send sequence number.
   * A counter rather than a clock: "was this delivered after that text arrived" must not
   * depend on two calls landing in different milliseconds.
   */
  private readonly lastDelivered = new Map<string, { text: string; seq: number }>();
  private sendSeq = 0;
  private readonly now: () => Date;
  private readonly sessionsDir: string;
  private readonly notifier: OwnerNotifier;
  private readonly a2aStore: A2AStore;
  private readonly inboundRuns = new Map<string, Promise<HandleResult>>();
  private readonly inboundQueues = new Map<string, Promise<unknown>>();
  private readonly a2aAdmissions = new Map<string, Promise<unknown>>();
  private readonly backgroundReplies = new Set<string>();
  private ownerLast?: { conversationKey: string; channel: Channel };
  private ownerQueue?: OwnerQueue;

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.sessionsDir = deps.sessionsDir ?? deps.state.path("sessions");
    deps.state.ensure();
    this.a2aStore = deps.a2aStore ?? new A2AStore(deps.state);
    if (deps.housekeeping !== false) {
      const t = setInterval(() => void this.housekeeping().catch(() => undefined), 5 * 60_000);
      (t as { unref?: () => void }).unref?.();
    }
    const savedRoute = deps.state.readJson<{ conversationKey?: unknown; channel?: unknown }>("owner-route.json", {});
    if (typeof savedRoute.conversationKey === "string" && ["imessage", "sms"].includes(String(savedRoute.channel))) {
      this.ownerLast = { conversationKey: savedRoute.conversationKey, channel: savedRoute.channel as Channel };
    }
    this.notifier = new OwnerNotifier({
      state: deps.state,
      audit: deps.audit,
      now: this.now,
      send: (text) => this.sendToOwner(text, this.ownerPrincipal(), "system"),
    });
  }

  ownerPrincipal(): Principal {
    const owner = this.deps.config.owner;
    return {
      kind: "owner",
      id: "owner",
      tier: "owner",
      displayName: owner.name,
      phone: owner.phones[0],
      email: owner.emails[0],
    };
  }

  stats(): { conversations: number; busy: number } {
    let busy = 0;
    for (const c of this.conversations.values()) if (c.busy) busy++;
    return { conversations: this.conversations.size, busy };
  }

  /**
   * Get or create the conversation for a runtime key. The same person at a changed tier
   * keeps their transcript and gets the tools rebound. A different principal on the same
   * key never inherits the transcript: it gets a fresh conversation with empty context.
   */
  conversation(key: string, principal: Principal, opts: ConversationOpts = {}): Conversation {
    const existing = this.conversations.get(key);
    if (existing) {
      if (existing.principal.id === principal.id) {
        if (existing.principal.tier !== principal.tier || existing.principal.cappedFrom !== principal.cappedFrom) {
          existing.principal = principal;
          existing.agent.state.tools = this.bindTools(existing);
        }
        if (opts.replyRef) existing.replyRef = opts.replyRef;
        this.rememberConversation(existing);
        return existing;
      }
      // The old conversation finishes on its own and is simply no longer the one for this key.
      this.conversations.delete(key);
      this.deps.audit.append({ kind: "policy", conversationKey: key, principal: principal.id, detail: { reset: "principal changed", from: existing.principal.id } });
      return this.createConversation(key, principal, opts, []);
    }
    const sessionFile = join(this.sessionsDir, `${encodeURIComponent(key)}.jsonl`);
    const record = this.recallRecord(key);
    // A transcript on disk belongs to whoever wrote it; someone else starts clean.
    const stored = record && record.principal.id !== principal.id ? [] : readSession(sessionFile);
    return this.createConversation(key, principal, { deliveryKey: opts.deliveryKey ?? record?.deliveryKey, replyRef: opts.replyRef ?? record?.replyRef }, stored);
  }

  private createConversation(key: string, principal: Principal, opts: ConversationOpts, stored: AgentMessage[]): Conversation {
    const channel = channelOf(key);
    const sessionFile = join(this.sessionsDir, `${encodeURIComponent(key)}.jsonl`);
    const restored = restoreMessages(stored, this.now());

    // The Conversation needs the Agent and the Agent's hooks need the Conversation, so the
    // Agent is created with a placeholder tool list and tools are bound right after.
    let conv!: Conversation;
    const agent = new Agent({
      initialState: {
        systemPrompt: "",
        model: this.deps.model,
        thinkingLevel: this.deps.config.model.thinking ?? "medium",
        tools: [],
        messages: restored,
      },
      streamFn: this.deps.streamFn ?? (streamSimple as StreamFn),
      getApiKey: this.deps.getApiKey,
      toolExecution: "sequential",
      transformContext: async (messages) => trimContext(messages, this.now()),
      beforeToolCall: async ({ toolCall, args }) => this.guard(conv, toolCall.name, args),
      afterToolCall: async ({ toolCall, args, isError, result }) => {
        this.recordToolCall(conv, toolCall.name, args, isError, result?.content);
        return undefined;
      },
    });
    conv = new Conversation({
      key,
      deliveryKey: opts.deliveryKey ?? key,
      principal,
      channel,
      agent,
      sessionFile,
      replyRef: opts.replyRef ?? {},
      now: this.now,
      refreshPrompt: () => this.systemPromptFor(conv),
    });
    agent.state.tools = this.bindTools(conv);
    this.conversations.set(key, conv);
    if (stored.length === 0) writeSession(sessionFile, []);
    this.rememberConversation(conv);
    return conv;
  }

  async handleInbound(incoming: InboundMessage, opts: { waitForCompletion?: boolean } = {}): Promise<HandleResult> {
    let msg = incoming;
    const arrivedAt = this.now().getTime();
    const originalPrincipal = resolvePrincipal(msg, this.deps.config, this.deps.contacts);
    let base = { principal: originalPrincipal, conversationKey: msg.conversationKey, acked: true as const };
    if (this.seenBefore(msg.id)) return { ...base, blocked: "duplicate" };
    if (msg.channel === "a2a" && !this.peerExempt(msg, originalPrincipal) && this.peerOverLimit(originalPrincipal.agentHandle ?? msg.from, arrivedAt)) {
      // One agent on a cron can flood every agent it knows (45 pings per ten minutes was seen);
      // beyond the hourly ceiling its messages are dropped unread, so the owner never hears them.
      this.markSeen(msg.id);
      this.deps.audit.append({ kind: "policy", conversationKey: msg.conversationKey, principal: originalPrincipal.id, detail: { blocked: "a2a-rate-limit", peer: originalPrincipal.agentHandle ?? msg.from } });
      return { ...base, blocked: "rate-limited" };
    }
    if (msg.channel === "a2a" && msg.meta?.eventType === "a2a.task.canceled") {
      this.cancelA2A(msg);
      this.markSeen(msg.id);
      return { ...base, blocked: "canceled" };
    }
    let run = this.inboundRuns.get(msg.id);
    if (!run) {
      // Only a new, not-yet-seen message with a resolved 1:1 scope may claim the owner seat.
      const claimed = this.maybeClaimOwner(msg);
      if (claimed) {
        msg = claimed;
        base = { ...base, principal: resolvePrincipal(msg, this.deps.config, this.deps.contacts) };
      }
      run = this.processInbound(msg);
      this.inboundRuns.set(msg.id, run);
      void run.finally(() => this.inboundRuns.delete(msg.id)).catch(() => undefined);
    }
    const budgetMs = this.deps.replyBudgetMs ?? DEFAULT_REPLY_BUDGET_MS;
    if (opts.waitForCompletion) return run;
    const outcome = await withinBudget(run.then((result) => ({ result }), (error: unknown) => ({ error })), budgetMs);
    if (outcome.state !== "done") {
      this.backgroundReplies.add(msg.id);
      // A carrier thread gets its texted "on it" from runInbound (ackSlowReplies), on every path.
      return { ...base, reply: ackText(msg.channel) };
    }
    if ("error" in outcome.value) throw outcome.value.error;
    return outcome.value.result;
  }

  /**
   * An agent handed out before its owner's phone was known (config.owner.claimOnFirstContact
   * with no phones) adopts the first person who texts it 1:1 on a carrier channel a message
   * containing the one-time claim code (owner-claim.ts). No valid code configured means no
   * claim at all. Group threads, unresolved scopes, reactions, email and A2A never claim. A
   * wrong code leaves the sender an ordinary stranger and does not use up the claim, but each
   * number gets only MAX_CLAIM_ATTEMPTS tries. On success the phone is written to config.json,
   * the flag and the code are cleared so they cannot be reused, and the returned message has
   * the code stripped so it never reaches the model or the transcript.
   */
  private maybeClaimOwner(msg: InboundMessage): InboundMessage | undefined {
    const { config, state, audit } = this.deps;
    const owner = config.owner;
    if (!owner.claimOnFirstContact || owner.phones.length > 0) return undefined;
    if (msg.channel !== "imessage" && msg.channel !== "sms") return undefined;
    if (msg.meta?.conversationScopeKnown !== true || isGroup(msg)) return undefined;
    if (msg.meta?.reaction !== undefined) return undefined;
    const from = (msg.from ?? "").trim();
    if (!looksLikePhone(from)) return undefined;
    const phone = normalizePhone(from);
    if (!phone) return undefined;
    const status = ownerClaimStatus(config, this.now());
    if (!status.enabled) return undefined;
    const attempts = state.readJson<Record<string, number>>(CLAIM_ATTEMPTS_FILE, {});
    if ((attempts[phone] ?? 0) >= MAX_CLAIM_ATTEMPTS) return undefined;
    const match = matchClaimCode(msg.text, status.code);
    if (!match.matched) {
      attempts[phone] = (attempts[phone] ?? 0) + 1;
      state.writeJson(CLAIM_ATTEMPTS_FILE, attempts);
      if (attempts[phone] === MAX_CLAIM_ATTEMPTS) {
        audit.append({ kind: "policy", conversationKey: msg.conversationKey, principal: `stranger:${msg.channel}:${phone}`, detail: { ownerClaimLocked: true, channel: msg.channel, phone } });
      }
      return undefined;
    }
    owner.phones = [phone];
    owner.claimOnFirstContact = false;
    delete owner.claimCode;
    delete owner.claimExpiresAt;
    saveConfig(state, config);
    state.writeJson(CLAIM_ATTEMPTS_FILE, {});
    audit.append({
      kind: "policy",
      conversationKey: msg.conversationKey,
      principal: "owner",
      detail: { ownerClaimed: true, channel: msg.channel, phone },
    });
    return { ...msg, text: match.rest || CLAIM_WELCOME_TEXT };
  }

  private async processInbound(original: InboundMessage): Promise<HandleResult> {
    if (original.meta?.conversationScopeKnown === false) throw new Error("Conversation scope must be resolved before delivery");
    // Taken before any wait: a reply sent after this point was sent after this text arrived.
    const arrivedSeq = this.sendSeq;
    const processing = this.deps.state.readJson<string[]>(PROCESSING_FILE, []);
    if (processing.includes(original.id)) throw new InboundUncertainError(original.id);
    const prepared = await this.prepareA2A(original);
    if (!prepared) {
      this.markSeen(original.id);
      return { acked: true, principal: resolvePrincipal(original, this.deps.config, this.deps.contacts), conversationKey: original.conversationKey, blocked: "inactive-task" };
    }
    const { msg, principal, key } = prepared;
    const queueKey = key ?? runtimeKey(msg, principal ?? resolvePrincipal(msg, this.deps.config, this.deps.contacts));
    // Waiting behind another message in the same conversation: that run already owns the "on it".
    const queued = this.inboundQueues.has(queueKey);
    let before = this.inboundQueues.get(queueKey) ?? Promise.resolve();
    // A run that never ends would hold every later message for this conversation behind it.
    const holding = this.conversations.get(queueKey);
    const maxRunMs = this.deps.maxRunMs ?? DEFAULT_MAX_RUN_MS;
    if (holding?.busy && (await holding.abortIfStuck(maxRunMs))) {
      this.deps.audit.append({ kind: "error", conversationKey: holding.key, principal: holding.principal.id, detail: { message: `Aborted a run that had been going for over ${Math.round(maxRunMs / 60_000)} minutes; starting fresh with the new message` } });
      // A tool that ignores the abort keeps that Agent "processing" forever; rebuild the conversation from its saved transcript.
      this.conversations.delete(queueKey);
      before = Promise.resolve();
    }
    const work = before.catch(() => undefined).then(async () => {
      if (this.seenBefore(original.id)) return { acked: true as const, principal: principal ?? resolvePrincipal(msg, this.deps.config, this.deps.contacts), conversationKey: msg.conversationKey, blocked: "duplicate" };
      const active = this.deps.state.readJson<string[]>(PROCESSING_FILE, []);
      this.deps.state.writeJson(PROCESSING_FILE, [...active, original.id]);
      try {
        const result = await this.runInbound(msg, principal, key, { arrivedSeq, queued });
        if (this.backgroundReplies.delete(original.id) && !DELIVERABLE.has(msg.channel) && result.reply) this.stash(queueKey, lateAnswer(msg.text, result.reply));
        this.markSeen(original.id);
        this.deps.state.writeJson(PROCESSING_FILE, this.deps.state.readJson<string[]>(PROCESSING_FILE, []).filter((id) => id !== original.id));
        return result;
      } catch (error) {
        throw new InboundUncertainError(original.id, error);
      }
    });
    this.inboundQueues.set(queueKey, work);
    void work.finally(() => { if (this.inboundQueues.get(queueKey) === work) this.inboundQueues.delete(queueKey); }).catch(() => undefined);
    return work;
  }

  private async runInbound(msg: InboundMessage, routedPrincipal: Principal | undefined, routedKey: string | undefined, arrival: { arrivedSeq: number; queued: boolean }): Promise<HandleResult> {
    const { audit, approvals, config, contacts, policy } = this.deps;
    const group = isGroup(msg);
    let principal = routedPrincipal ?? resolvePrincipal(msg, config, contacts);
    if (msg.meta?.delegatedResult) {
      // Recheck after the session queue wait: preceding turns may have tightened its audience.
      principal = { ...principal };
      if (principal.contactId) {
        const currentTier = contacts.get(principal.contactId)?.tier ?? "stranger";
        if (TIER_ORDER.indexOf(currentTier) > TIER_ORDER.indexOf(principal.tier)) principal.tier = currentTier;
      }
      const key = routedKey ?? runtimeKey(msg, principal);
      const latestPrincipal = this.conversations.get(key)?.principal ?? this.recallRecord(key)?.principal;
      if (latestPrincipal?.id === principal.id && latestPrincipal.cappedFrom && TIER_ORDER.indexOf(latestPrincipal.tier) > TIER_ORDER.indexOf(principal.tier)) {
        principal.tier = latestPrincipal.tier;
        principal.cappedFrom ??= latestPrincipal.cappedFrom;
      }
    }
    if (group) principal = this.capForGroup(principal, msg);
    const base = { principal, conversationKey: msg.conversationKey };

    audit.append({
      kind: "inbound",
      conversationKey: msg.conversationKey,
      principal: principal.id,
      // What someone other than the owner asked is kept in a short preview, so "what have other agents asked about me" has an answer.
      detail: { id: msg.id, channel: msg.channel, from: msg.from, chars: msg.text.length, source: msg.source, ...(principal.kind !== "owner" ? { preview: msg.text.replace(/\s+/g, " ").trim().slice(0, 160) } : {}), ...(group ? { group: true, tier: principal.tier } : {}) },
    });

    if (principal.kind === "stranger") {
      const limit = this.strangerLimit(msg.conversationKey, policy.toJSON().strangerLimits);
      if (limit) {
        audit.append({ kind: "policy", conversationKey: msg.conversationKey, principal: principal.id, detail: { blocked: limit } });
        // Another agent would otherwise wait forever on a request nobody will answer.
        if (msg.channel === "a2a" && msg.replyRef?.taskId) {
          const text = `${this.deps.config.owner.name}'s agent can't take new requests from agents it doesn't know right now. Try again later, or reach ${this.deps.config.owner.name} directly.`;
          await this.safeSend({ channel: "a2a", conversationKey: msg.conversationKey, text, replyRef: msg.replyRef, a2a: { taskId: msg.replyRef.taskId, intent: "fail" } }, principal, msg.conversationKey);
        }
        return { ...base, acked: true, blocked: limit };
      }
    }

    let text = msg.text;
    let approvalNote: string | undefined;
    if (principal.kind === "owner" && !group && !msg.meta?.delegatedResult) {
      // The dashboard chat counts too: an owner with no phone yet still has a place where a
      // question can wait for them (see sendToOwnerNow).
      if ((DELIVERABLE.has(msg.channel) && msg.channel !== "a2a") || msg.channel === "chat") {
        this.ownerLast = { conversationKey: msg.conversationKey, channel: msg.channel };
        this.deps.state.writeJson("owner-route.json", this.ownerLast);
      }
      // Only a carrier-bound or local channel can settle an approval; an email From is not proof.
      const match = APPROVAL_CHANNELS.has(msg.channel) ? approvals.matchReply(msg.text) : undefined;
      if (match) {
        approvalNote = await this.settleApproval(msg, principal, match);
        if (!match.remainder) return { ...base, acked: true, reply: approvalNote };
        text = match.remainder;
      }
    }

    // Everything the sender controls (text, attachment names, data parts) sits inside the
    // untrusted boundary when the sender is not the owner.
    const body = withData(withAttachments(text, msg), msg, this.deps.describeData);
    const wrapped = principal.kind === "owner" && !msg.meta?.delegatedResult ? body : wrapUntrusted(body, untrustedLabel(msg, principal));
    // Two owners who ask for the same intro send two requests that cross; each side then asks its
    // owner to approve what that owner already asked for, and the intro deadlocks. Say so.
    // Only an open meeting ask from the owner counts as their yes: a late note or a question to that peer
    // once committed owners to new proposals, moves and 3-ways (testing). Moves and group asks always go to the owner.
    const incomingMove = /\b(move|moving|reschedul|push (?:it|back)|instead of|3-way|three-way|group)\b/i.test(msg.text ?? "");
    // A move counts only when the owner asked that same peer for a move too: both owners asking at once
    // stalled every move in testing (each agent asked its owner to approve what the owner had asked for).
    const MOVE_ASK = /\b(move|moving|reschedul|push (?:it|back)|instead|change (?:it|the time))\b/i;
    const ownerMeetingAsks = principal.kind === "agent" && msg.channel === "a2a" && principal.agentHandle
      ? this.a2aStore.ownerAsksTo(principal.agentHandle).filter((d) => MEETING_ASK.test(d.summary ?? "") && !OWNER_NOTE.test(d.summary ?? ""))
      : [];
    const groupAsk = /\b(3-way|three-way|group)\b/i.test(msg.text ?? "");
    const mutual = groupAsk ? undefined : incomingMove ? ownerMeetingAsks.find((d) => MOVE_ASK.test(d.summary ?? "")) : ownerMeetingAsks[0];
    const replyTo = principal.kind === "agent" && msg.channel === "a2a" && msg.replyRef?.taskId ? this.a2aStore.delegation(msg.replyRef.taskId) : undefined;
    const closeNote = replyTo && replyTo.principal.kind === "owner" && !mutual
      ? `This is ${principal.displayName}'s agent answering the ask you sent for ${this.deps.config.owner.name}${replyTo.summary ? ` ("${replyTo.summary}")` : ""}. Close it now: if it accepts a time and place, call meeting_record and text ${this.deps.config.owner.name} one line (who, when, where). If it offers a different time that is free, accept it with reply_instinct, record it, and tell ${this.deps.config.owner.name} in one line. Ask ${this.deps.config.owner.name} only if it clashes with a recorded meeting. Never ask them to approve what they already asked for.`
      : undefined;
    const userText = mutual ? `${mutualAskNote(this.deps.config.owner.name, principal.displayName, mutual)}\n\n${wrapped}` : closeNote ? `${closeNote}\n\n${wrapped}` : wrapped;
    const conv = this.conversation(routedKey ?? runtimeKey(msg, principal), principal, { deliveryKey: msg.conversationKey, replyRef: msg.replyRef });
    if (conv.channel === "a2a" && !this.a2aStore.active(conv.replyRef.taskId ?? "", conv.replyRef.messageId)) return { ...base, acked: true, blocked: "inactive-task" };
    // Owner texts for a chat-only owner are stashed under the route's conversation key, which
    // is the delivery key, not the runtime key, so both are drained here.
    const stashed = [...this.takeStash(conv.key), ...(conv.deliveryKey !== conv.key ? this.takeStash(conv.deliveryKey) : []), ...(principal.kind === "owner" ? this.takeQuietHold().map((h) => h.text) : [])];
    const joinReply = (reply: string | undefined) => {
      const joined = joinOwnerParts([approvalNote, ...stashed], reply);
      return (principal.kind === "owner" ? tidyOwnerReply(joined) : joined) || undefined;
    };
    // Texts that waited for this turn are shown to the owner above the reply, so the model must
    // know them too, or it answers "nothing new" right under the news it is relaying.
    const seen = [approvalNote, ...stashed].filter((t): t is string => Boolean(t));
    const gap = principal.kind === "owner" ? this.gapNote(conv.key) : undefined;
    const notes = [seen.length > 0 && principal.kind === "owner" ? shownToOwnerNote(seen) : undefined, gap].filter((t): t is string => Boolean(t));
    const prompt = notes.length > 0 ? `${notes.join("\n\n")}\n\n${userText}` : userText;

    if (conv.busy) {
      conv.steer(prompt);
      // The owner asking "status?" during a long job used to get "taking a moment" for minutes.
      // Say what is happening now; the answer to this message comes with the job's result.
      const status = principal.kind === "owner" ? busyStatus(conv, this.now()) : undefined;
      if (status && msg.channel !== "chat" && DELIVERABLE.has(msg.channel)) {
        void this.safeSend({ channel: msg.channel as OutboundChannel, conversationKey: msg.conversationKey, text: status }, principal, msg.conversationKey).catch(() => undefined);
        return { ...base, acked: true, reply: joinReply(undefined) };
      }
      return { ...base, acked: true, reply: joinReply(status) };
    }

    // Typing is a courtesy, never a cost: it runs alongside the model and is dropped when slow.
    if (DELIVERABLE.has(msg.channel) && this.deps.outbox.typing) {
      void withinBudget(this.deps.outbox.typing(msg.conversationKey).catch(() => undefined), TYPING_TIMEOUT_MS);
    }

    const promptedBefore = approvals.promptedToken();
    // Only a run the owner started with their own words may settle an approval through a tool.
    conv.ownerTurn = principal.kind === "owner" && !group && !msg.meta?.delegatedResult && APPROVAL_CHANNELS.has(msg.channel);
    const ack = this.startSlowReplyAck(msg, principal, group || arrival.queued || Boolean(msg.meta?.delegatedResult));
    const run = conv.run(prompt).finally(() => {
      conv.ownerTurn = false;
    }).then(
      (reply) => ({ ok: true as const, reply }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let outcome = await run;
    // "Sent" with nothing sent: testing had an agent report a note it never sent, then wait on a reply
    // for five turns. Ask the model once to send it or say plainly it did not.
    if (outcome.ok && principal.kind === "owner" && !conv.sentThisRun && claimsSend(outcome.reply)) {
      this.deps.audit.append({ kind: "policy", conversationKey: conv.key, principal: principal.id, detail: { outcome: "corrected", reason: "reply claimed a send with no send tool call" } });
      outcome = await conv.run("[Check: your reply says something was sent, but no message went out in this turn (no ask_instinct, send_message or reply_instinct succeeded). Either send it now and confirm, or tell the owner plainly that it was not sent and why. Reply to the owner only.]").then(
        (r) => ({ ok: true as const, reply: r }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    }
    // A note for the owner ("running 10 minutes late", "what are you working on?") was answered and closed
    // without the owner ever hearing it in rounds 1 and 2 (5 of 16 reached them). Pass it on when the run didn't.
    const peerAgent = principal.kind === "agent" || (principal.kind === "stranger" && Boolean(principal.agentHandle));
    // A reply to an ask the owner started (a yes, a counter-offer, a decline) is the owner's news too.
    const answersOwner = Boolean(msg.replyRef?.taskId && this.a2aStore.delegation(msg.replyRef.taskId)?.principal.kind === "owner");
    if (outcome.ok && peerAgent && msg.channel === "a2a" && !conv.relayedThisRun && (answersOwner || OWNER_NOTE.test(msg.text ?? ""))) {
      const raw = (principal.onBehalfOf?.displayName ?? principal.displayName).replace(/\s*\(@[^)]*\)/g, "").replace(/[\u2019']s (?:agent|instinct)$/i, "").trim();
      const who = /^@?[a-z0-9]+(?:-[a-z0-9]+)+$/.test(raw)
        ? raw.replace(/^@/, "").split("-").filter((x, i, a) => !(i === a.length - 1 && a.length > 1 && /^[a-z0-9]{4,6}$/.test(x) && /\d/.test(x))).map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(" ")
        : raw;
      const said = (msg.text ?? "").replace(/\s+/g, " ").trim();
      await this.sendToOwner(`From ${who}: ${said.length > 280 ? `${said.slice(0, 277)}…` : said}`, this.ownerPrincipal(), conv.key).catch(() => undefined);
    }
    // The "on it" lands before the answer or not at all.
    await ack.stop();
    let reply = this.replyText(outcome, principal);
    if (!outcome.ok) this.auditError(conv.key, principal, outcome.error);
    if (outcome.ok && principal.kind === "owner") reply = scrubUnverifiedLinks(reply, conv.recentToolText(), conv.knownText());
    // Models often send only the caption ("Your notes") and drop the block that attaches the file.
    if (outcome.ok && principal.kind === "owner") reply = tidyOwnerReply(withFileFences(reply, conv.fileFences));
    if (DELIVERABLE.has(msg.channel) && reply) {
      await this.deliver(conv, reply, { keepPrompt: approvals.promptedToken() !== promptedBefore, arrivedSeq: arrival.arrivedSeq, failure: !outcome.ok });
    }
    // The dashboard chat answers in the HTTP response, not through deliver(), so it clears the
    // approval context here: a bare "yes" to this reply must not settle an approval asked earlier.
    else if (msg.channel === "chat" && principal.kind === "owner" && reply && approvals.promptedToken() === promptedBefore) approvals.clearPrompted();
    return { ...base, acked: true, reply: joinReply(reply) };
  }

  /**
   * After hours of silence (the owner was busy, or the agent was down and messages were lost),
   * the model read the thread as continuous and revived a call request from that morning. Mark
   * a long gap so the new message is answered on its own.
   */
  private gapNote(key: string): string | undefined {
    const all = this.deps.state.readJson<Record<string, string>>(LAST_OWNER_TURN_FILE, {});
    const prev = Date.parse(all[key] ?? "");
    all[key] = this.now().toISOString();
    this.deps.state.writeJson(LAST_OWNER_TURN_FILE, all);
    const gap = this.now().getTime() - prev;
    if (!Number.isFinite(gap) || gap < GAP_NOTE_MS) return undefined;
    return gapNoteText(gap);
  }

  /** Scheduled jobs run as the owner in their own conversation; results go to the owner's phone. */
  async runScheduled(entry: ScheduleEntry): Promise<void> {
    const principal = this.ownerPrincipal();
    const key = `scheduled:${entry.id}`;
    const conv = this.conversation(key, principal);
    this.deps.audit.append({ kind: "schedule", conversationKey: key, principal: principal.id, detail: { id: entry.id, name: entry.name, fired: true } });
    let text = "";
    const framed = `Scheduled job "${entry.name ?? entry.id}" is firing now. The text below is the job's own instruction, written earlier, not a new request from the owner: carry it out now. If it is a reminder, send the owner the reminder itself in one line; never create another schedule for it.\n\n${entry.prompt}`;
    try {
      text = await conv.run(framed);
    } catch (error) {
      this.auditError(key, principal, error);
      return;
    }
    if (!text.trim()) return;
    await this.sendToOwner(text, principal, key);
  }

  /**
   * A task the operator asked for (a `system.task` envelope): runs as the owner in
   * its own conversation. The result goes to the owner's phone unless the task is
   * quiet, in which case only its side effects (memory, schedules) remain. Like a
   * scheduled job, the owner did not write the prompt, so ownerTurn stays false and
   * approval_settle is refused inside it.
   */
  async runSystemTask(task: { id: string; name?: string; prompt: string; quiet?: boolean }): Promise<string> {
    const principal = this.ownerPrincipal();
    const key = `system:${task.id}`;
    const conv = this.conversation(key, principal);
    this.deps.audit.append({ kind: "schedule", conversationKey: key, principal: principal.id, detail: { systemTask: task.id, name: task.name, quiet: task.quiet === true } });
    let text = "";
    try {
      text = await conv.run(task.prompt);
    } catch (error) {
      this.auditError(key, principal, error);
      throw error;
    }
    if (!task.quiet && text.trim()) await this.sendToOwner(text, principal, key);
    return text;
  }

  // -------------------------------------------------------------------------
  // Policy guard and audit
  // -------------------------------------------------------------------------

  private async prepareA2A(msg: InboundMessage): Promise<{ msg: InboundMessage; principal?: Principal; key?: string } | undefined> {
    const taskId = msg.channel === "a2a" ? msg.replyRef.taskId : undefined;
    if (!taskId) return this.readA2AAdmission(msg);
    const previous = this.a2aAdmissions.get(taskId) ?? Promise.resolve();
    // Read and record together: an older delayed snapshot must not replace a newer generation.
    const admission = previous.catch(() => undefined).then(() => this.readA2AAdmission(msg));
    this.a2aAdmissions.set(taskId, admission);
    void admission.finally(() => {
      if (this.a2aAdmissions.get(taskId) === admission) this.a2aAdmissions.delete(taskId);
    }).catch(() => undefined);
    return admission;
  }

  private async readA2AAdmission(msg: InboundMessage): Promise<{ msg: InboundMessage; principal?: Principal; key?: string } | undefined> {
    if (msg.channel !== "a2a") return { msg };
    const taskId = msg.replyRef.taskId;
    if (!taskId) return undefined;
    if (msg.meta?.direction === "sent" || msg.meta?.eventType === "a2a.sent_task.updated") {
      const state = a2aState(msg.meta?.state);
      if (state === "submitted" || state === "working") return undefined;
      let route = this.a2aStore.delegation(taskId);
      if (!route && this.a2aStore.hasPending() && this.deps.loadA2ATask) {
        const task = asRecord(await this.deps.loadA2ATask(taskId));
        if (String(task.id ?? "") !== taskId) throw new Error("A2A task response does not match the update");
        const messages = Array.isArray(task.messages) ? task.messages.map(asRecord) : [];
        for (const message of messages) {
          const pending = this.a2aStore.byMessage(String(message.message_id ?? message.messageId ?? ""));
          if (!pending || String(asRecord(task.target).handle ?? "") !== pending.peer) continue;
          this.a2aStore.confirm(pending.messageId, { taskId, contextId: String(task.context_id ?? task.contextId ?? "") });
          route = this.a2aStore.delegation(taskId);
          break;
        }
      }
      if (!route) {
        if (this.a2aStore.hasPending()) throw new Error("A2A delegation is still being recorded; retry delivery");
        return undefined;
      }
      const principal = { ...route.principal };
      return {
        msg: { ...msg, channel: channelOf(route.conversationKey), conversationKey: route.deliveryKey, replyRef: route.replyRef ?? {}, text: `Delegated task ${taskId} with @${route.peer} is ${state || "updated"}.\n${msg.text}`, meta: { ...msg.meta, delegatedResult: true } },
        principal,
        key: route.conversationKey,
      };
    }
    let admitted = msg;
    let state = a2aState(msg.meta?.state) || "working";
    if (this.deps.loadA2ATask) {
      const task = asRecord(await this.deps.loadA2ATask(taskId));
      if (String(task.id ?? "") !== taskId || String(task.context_id ?? task.contextId ?? "") !== msg.replyRef.contextId) throw new Error("A2A task response does not match the event");
      state = a2aState(task.state ?? asRecord(task.status).state);
      if (a2aTerminal(state) || !["submitted", "working"].includes(state)) return undefined;
      const history = Array.isArray(task.messages) ? task.messages.map(asRecord) : [];
      const latest = history.filter((m) => String(m.role).toLowerCase() === "caller").at(-1);
      if (!latest || String(latest.message_id ?? latest.messageId ?? "") !== msg.replyRef.messageId) return undefined;
      const caller = asRecord(task.caller);
      if (typeof caller.handle !== "string" || !caller.handle) throw new Error("A2A task has no authenticated caller");
      const parts = Array.isArray(latest.parts) ? latest.parts.map(asRecord) : [];
      const text = parts.flatMap((p) => typeof p.text === "string" ? [p.text] : []).join("\n\n");
      const data = parts.find((p) => p.data && typeof p.data === "object")?.data as Record<string, unknown> | undefined;
      const prior = history.slice(0, -1).map((m) => `${String(m.role)}: ${JSON.stringify(m.parts ?? [])}`).join("\n");
      admitted = { ...msg, from: caller.handle, text: prior ? `Earlier messages in this task:\n${clip(prior, 24_000)}\n\nCurrent request:\n${text}` : text, ...(data ? { data } : {}) };
    }
    if (!this.a2aStore.active(taskId)) return undefined;
    const key = runtimeKey(admitted, resolvePrincipal(admitted, this.deps.config, this.deps.contacts));
    this.a2aStore.recordTask({ taskId, contextId: msg.replyRef.contextId, messageId: msg.replyRef.messageId, state, conversationKey: key });
    return { msg: admitted };
  }

  private cancelA2A(msg: InboundMessage): void {
    const taskId = msg.replyRef.taskId;
    if (!taskId) return;
    this.a2aStore.recordTask({ taskId, state: "canceled" });
    for (const conv of this.conversations.values()) {
      if (conv.channel === "a2a" && conv.replyRef.taskId === taskId) conv.agent.abort();
    }
    for (const approval of this.deps.approvals.pending()) {
      if (this.recallRecord(approval.conversationKey)?.replyRef?.taskId === taskId) this.deps.approvals.resolve(approval.token, false);
    }
    const approved = this.deps.state.readJson<ApprovedRecord[]>(APPROVED_FILE, []);
    this.deps.state.writeJson(APPROVED_FILE, approved.filter((a) => this.recallRecord(a.conversationKey)?.replyRef?.taskId !== taskId));
  }

  private async assertA2AActive(conv: Conversation): Promise<void> {
    const { taskId, messageId } = conv.replyRef;
    if (!taskId || !this.a2aStore.active(taskId, messageId) || a2aState(this.a2aStore.task(taskId)?.state) === "input_required") throw new A2AInactiveError("The A2A task is no longer active");
    if (!this.deps.loadA2ATask) return;
    const task = asRecord(await this.deps.loadA2ATask(taskId));
    const state = a2aState(task.state ?? asRecord(task.status).state);
    const messages = Array.isArray(task.messages) ? task.messages.map(asRecord) : [];
    const latest = messages.filter((m) => String(m.role).toLowerCase() === "caller").at(-1);
    if (String(task.id ?? "") !== taskId || !["submitted", "working"].includes(state) || (messageId && String(latest?.message_id ?? latest?.messageId ?? "") !== messageId)) {
      if (a2aTerminal(state)) this.a2aStore.recordTask({ taskId, state });
      throw new A2AInactiveError("The A2A task changed or is no longer active");
    }
  }

  private async guard(conv: Conversation, toolName: string, args: unknown): Promise<BeforeToolCallResult | undefined> {
    if (conv.channel === "a2a") {
      try { await this.assertA2AActive(conv); }
      catch (error) {
        if (!(error instanceof A2AInactiveError)) throw error;
        return { block: true, reason: "This A2A task is no longer active. Stop without taking any action." };
      }
    }
    conv.activity = toolName;
    const { registry, policy, audit, approvals, config } = this.deps;
    const meta = registry.meta(toolName);
    if (!meta) return undefined;
    const principal = conv.principal;

    if (principal.kind === "stranger" && meta.capabilities.includes("owner.relay")) {
      const limit = this.strangerRelayLimit(policy.toJSON().strangerLimits);
      if (limit) return { block: true, reason: limit };
    }

    const decision = policy.evaluate(principal, meta, args);
    audit.append({
      kind: "policy",
      conversationKey: conv.key,
      principal: principal.id,
      detail: { tool: toolName, outcome: decision.outcome, reason: decision.reason, ...(decision.outcome === "allow" && decision.viaGrant ? { viaGrant: decision.viaGrant } : {}) },
    });

    if (decision.outcome === "allow") return undefined;
    if (decision.outcome === "deny") {
      // Enforced twice: the requester hears a polite no, and the owner hears that it was asked.
      if (principal.kind !== "owner") {
        await this.notifier.notify({ conversationKey: conv.key, principal: principal.id, action: safeDescribe(meta, args), outcome: "declined" }, principal.displayName);
      }
      return { block: true, reason: `Blocked by policy: ${decision.reason}. Do not retry. Explain politely that you cannot do this for them.` };
    }

    const amountUsd = meta.amountUsd?.(args);
    const capability = askedCapability(principal, meta);
    const argsHash = hashArgs(args);

    // The owner already said yes to this exact call in this conversation: spend that approval once.
    const consumed = this.consumeApproval({ conversationKey: conv.key, requestedBy: principal.id, capability, toolName, argsHash, amountUsd });
    if (consumed) {
      audit.append({ kind: "policy", conversationKey: conv.key, principal: principal.id, detail: { tool: toolName, outcome: "allow", reason: `owner approved ${consumed.token}: ${consumed.summary}` } });
      return undefined;
    }

    // The same call is already waiting on the owner: do not text them twice.
    const waiting = approvals.findPending({ conversationKey: conv.key, toolName, argsHash });
    const approval =
      waiting ??
      approvals.create({
        conversationKey: conv.key,
        requestedBy: principal.id,
        summary: decision.approvalPrompt,
        capability,
        toolName,
        argsHash,
        ...(amountUsd !== undefined ? { amountUsd } : {}),
      });
    if (!waiting) {
      audit.append({ kind: "approval", conversationKey: conv.key, principal: principal.id, detail: { token: approval.token, status: "pending", summary: approval.summary, tool: toolName } });
      await this.sendToOwner(approvalText(approval, principal, config), this.ownerPrincipal(), conv.key, { approvalToken: approval.token });
    }
    return {
      block: true,
      reason:
        `Waiting for ${config.owner.name}'s approval: ${approval.summary}. ` +
        `Do not call this tool again. Tell the requester you are checking with ${config.owner.name} and end your turn. ` +
        `You will receive a message starting with "Owner approved" or "Owner denied" when they answer.`,
    };
  }

  private recordToolCall(conv: Conversation, toolName: string, args: unknown, isError: boolean, content: unknown): void {
    const { registry, audit } = this.deps;
    const meta = registry.meta(toolName);
    const detail: Record<string, unknown> = { tool: toolName, isError, summary: safeDescribe(meta, args) };
    const preview = contentPreview(content);
    if (preview) detail.result = preview;
    for (const link of extractLinks(content)) conv.links.add(link);
    audit.append({ kind: "tool_call", conversationKey: conv.key, principal: conv.principal.id, detail });
    if (toolName === REPLY_TOOL && !isError) conv.repliedViaTool = true;
    if (isError) return;
    if (SEND_TOOLS.has(toolName)) conv.sentThisRun = true;
    if (toolName === "notify_owner" || toolName === "ask_owner") conv.relayedThisRun = true;
    for (const fence of fileFencesIn(content)) if (!conv.fileFences.includes(fence)) conv.fileFences.push(fence);
    if (meta?.recordsOwnSpend) return;
    const amountUsd = meta?.amountUsd?.(args);
    const spends = meta?.capabilities.some((c) => SPEND_CAPABILITIES.has(c)) ?? false;
    if ((amountUsd !== undefined && amountUsd > 0) || spends) {
      // Spend entries feed the daily total; a purchase with no amount is still recorded so it is visible.
      audit.append({ kind: "spend", conversationKey: conv.key, principal: conv.principal.id, detail: { tool: toolName, ...(amountUsd !== undefined ? { amountUsd } : {}), summary: safeDescribe(meta, args) } });
    }
  }

  private auditError(conversationKey: string, principal: Principal, error: unknown): void {
    this.deps.audit.append({ kind: "error", conversationKey, principal: principal.id, detail: { message: errorMessage(error) } });
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  /** Record the owner's verdict, wake the waiting conversation, and return the note for the owner. */
  private async settleApproval(msg: InboundMessage, principal: Principal, match: ApprovalMatch): Promise<string> {
    const { approvals, audit } = this.deps;
    // matchReply already resolves the approval; only resolve here if a custom store left it pending.
    const resolved = match.approval.status === "pending" ? approvals.resolve(match.approval.token, match.approved) ?? match.approval : match.approval;
    const record = this.recallRecord(resolved.conversationKey);
    if (record?.replyRef?.taskId && !this.a2aStore.active(record.replyRef.taskId, record.replyRef.messageId)) return "That task is no longer active; no action was taken.";
    const verb = match.approved ? "approved" : "denied";
    audit.append({ kind: "approval", conversationKey: resolved.conversationKey, principal: principal.id, detail: { token: resolved.token, status: resolved.status, summary: resolved.summary } });

    const what = humanApprovalSummary(resolved.summary);
    const note = match.approved ? `Got it, that's a yes${what ? `: ${what}` : ""}.` : `Got it, that's a no${what ? `: ${what}` : ""}.`;
    // The thread that asked is woken next and reports in its own words ("Sent to Sam's agent..."),
    // so a system-sounding line first would be noise. Only when that thread is gone does the owner
    // get one short human line here.
    const origin = resolved.conversationKey;
    const willReport = origin === msg.conversationKey || this.conversations.has(origin) || this.recallRecord(origin) !== undefined;
    await this.afterApproval(resolved, match.approved);

    if (DELIVERABLE.has(msg.channel) && !willReport) {
      const text = match.approved ? `Done. ${resolved.summary}.` : `Okay, I won't. ${resolved.summary}.`;
      await this.safeSend({ channel: msg.channel as OutboundChannel, conversationKey: msg.conversationKey, text, replyRef: msg.replyRef }, principal, msg.conversationKey);
    }
    return note;
  }

  /**
   * What happens once an approval is settled, whether by a yes/no text or by the
   * approval_settle tool: remember a policy grant, then wake the conversation that
   * asked. A relay approval (ask_owner) informs the model through the follow-up only;
   * it never pre-authorises a policy ask.
   */
  async afterApproval(approval: Approval, approved: boolean): Promise<void> {
    if (approved && approval.capability !== "owner.relay") this.rememberApproved(approval);
    // An agent that wrote first is a stranger with no contact, so after the owner's yes the reply had
    // nowhere to go ("Grace isn't in your contacts", "send me Grace's handle"). The owner's yes makes it
    // a contact the agent can reach by name.
    const stranger = /^stranger:a2a:@?(.+)$/.exec(approval.requestedBy ?? "");
    if (approved && stranger) {
      try {
        this.deps.contacts.upsert({ name: nameFromAgentHandle(stranger[1]!), agentHandle: `@${stranger[1]!.replace(/^@/, "")}`, tier: "contact" });
      } catch {
        // A reserved or malformed handle stays a stranger.
      }
    }
    // testing: an approved yes stalled with "I'm not in the A2A reply context" when the other agent's task had ended.
    const fromAgent = /^(?:agent|stranger:a2a):/.test(approval.requestedBy ?? "");
    const how = fromAgent ? " Tell the other agent now with reply_instinct, then tell the owner in one line. If the reply cannot be sent, tell the owner plainly that it did not go out; never say they are in or set before the other side has the answer." : "";
    await this.resumeConversation(approval.conversationKey, `Owner ${approved ? "approved" : "denied"}: ${approval.summary}.${how}`);
  }

  /** Wake the conversation that was waiting on the owner. Busy: queue. Idle: run and deliver. */
  private async resumeConversation(key: string, text: string): Promise<void> {
    const live = this.conversations.get(key);
    const record = live ? { principal: live.principal, deliveryKey: live.deliveryKey, replyRef: live.replyRef } : this.recallRecord(key);
    if (!record) return;
    const conv = this.conversation(key, record.principal, { deliveryKey: record.deliveryKey, replyRef: record.replyRef });
    if (conv.channel === "a2a") {
      try { await this.assertA2AActive(conv); } catch (error) { if (error instanceof A2AInactiveError) return; throw error; }
    }
    if (conv.busy) {
      // The current run owns this transcript until it has persisted and delivered.
      const running = this.inboundQueues.get(key);
      if (running) await running;
      else await conv.agent.waitForIdle();
    }
    const reply = await conv.run(text);
    if (reply) await this.deliver(conv, reply);
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  /**
   * Send the model's reply where the conversation lives. Dashboard chat has no outbox, so
   * its text is stashed for the next turn. A2A replies carry the task id and say "progress"
   * while an approval is pending, and are skipped when the model already answered itself.
   */
  private async deliver(conv: Conversation, text: string, opts: { keepPrompt?: boolean; arrivedSeq?: number; failure?: boolean } = {}): Promise<void> {
    const channel = conv.channel;
    if (channel === "scheduled" || channel === "system") return;
    // A run that said everything through tools (send_file with a caption, notify_owner) may end with nothing to add.
    if (!text.trim() && channel !== "a2a") return;
    if (conv.principal.kind === "owner" && channel !== "a2a") text = scrubUnverifiedLinks(text, conv.recentToolText(), conv.knownText());
    if (!DELIVERABLE.has(channel)) {
      this.stash(conv.key, text);
      return;
    }
    const out: OutboundMessage = { channel: channel as OutboundChannel, conversationKey: conv.deliveryKey, text, replyRef: conv.replyRef };
    if (channel === "a2a") {
      if (conv.repliedViaTool) return;
      if (!this.a2aStore.active(conv.replyRef.taskId ?? "", conv.replyRef.messageId)) return;
      if (!mayShareOwnerContact(conv.principal.tier) && ownerContactIn(text, this.deps.config.owner).length > 0) {
        this.deps.audit.append({ kind: "policy", conversationKey: conv.key, principal: conv.principal.id, detail: { outcome: "deny", tool: "a2a_reply", reason: "owner contact details to a non-partner agent" } });
        out.text = `${this.deps.config.owner.name} doesn't share contact details through agents. I can pass a message along.`;
      }
      try { await this.assertA2AActive(conv); } catch (error) { if (error instanceof A2AInactiveError) return; throw error; }
      const taskId = conv.replyRef.taskId;
      if (!taskId) {
        this.deps.audit.append({ kind: "error", conversationKey: conv.key, principal: conv.principal.id, detail: { message: "A2A reply dropped: no task id on record" } });
        return;
      }
      const waiting = this.deps.approvals.pending().some((a) => a.conversationKey === conv.key);
      out.a2a = { taskId, intent: waiting ? "progress" : "complete" };
    }
    if (this.duplicateOfQueuedReply(conv, text, opts)) {
      this.deps.audit.append({ kind: "outbound", conversationKey: conv.key, principal: conv.principal.id, detail: { channel, skipped: "duplicate reply", chars: text.length } });
      return;
    }
    // A reply to the owner changes what their next bare "yes" is about, unless this run raised the question.
    if (conv.principal.kind === "owner" && !opts.keepPrompt) this.deps.approvals.clearPrompted();
    await this.safeSend(out, conv.principal, conv.key);
    if (out.a2a && out.a2a.intent === "complete") this.a2aStore.recordTask({ taskId: out.a2a.taskId, state: "completed" });
  }

  /**
   * Several texts sent while one answer was being written are each run in turn, and the
   * later runs often end on that same answer. Only that echo is dropped: the reply repeats
   * the last bubble in the thread word for word, and the text that produced it arrived
   * before that bubble went out. A later request that happens to get the same answer
   * ("Done.") is news, a failure line is always worth repeating, and a shared thread is
   * never deduplicated because the same words may be for a different person.
   */
  private duplicateOfQueuedReply(conv: Conversation, text: string, opts: { arrivedSeq?: number; failure?: boolean }): boolean {
    if (!CARRIER_CHANNELS.has(conv.channel) || opts.failure || opts.arrivedSeq === undefined) return false;
    if (conv.key !== conv.deliveryKey) return false;
    const last = this.lastDelivered.get(conv.deliveryKey);
    return last !== undefined && last.text === text && last.seq > opts.arrivedSeq;
  }

  /**
   * With features.ackSlowReplies, an owner's own 1:1 text that is still running after the
   * reply budget gets one "on it" bubble. Never for a queued or steered text (the run in
   * front owns the thread), a group, or a run that already put something in the thread.
   * stop() cancels a pending ack and waits for one already sending, so it lands first.
   */
  private startSlowReplyAck(msg: InboundMessage, principal: Principal, skip: boolean): { stop: () => Promise<void> } {
    const eligible = this.deps.config.features.ackSlowReplies === true && CARRIER_CHANNELS.has(msg.channel) && principal.kind === "owner" && !skip;
    if (!eligible) return { stop: async () => undefined };
    const thread = msg.conversationKey;
    const startSeq = this.sendSeq;
    let sending: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timer = undefined;
      if ((this.lastDelivered.get(thread)?.seq ?? -1) > startSeq) return;
      sending = this.safeSend({ channel: msg.channel as OutboundChannel, conversationKey: thread, text: ackText(msg.channel), replyRef: msg.replyRef }, principal, thread).catch(() => undefined);
    }, this.deps.replyBudgetMs ?? DEFAULT_REPLY_BUDGET_MS);
    return {
      stop: async () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (sending) await sending;
      },
    };
  }

  /**
   * For tools that talk to the owner (ask_owner, notify_owner): the same route, merge window
   * and chat fallback as the runtime's own messages. False when there is no way to reach them.
   */
  async relayToOwner(text: string, originKey: string, opts: { approvalToken?: string; principal?: Principal } = {}): Promise<boolean> {
    const last = this.ownerLast;
    const reachable = Boolean(this.deps.config.owner.phones[0]) || Boolean(last && (last.channel === "chat" || (DELIVERABLE.has(last.channel) && last.channel !== "a2a")));
    if (!reachable) return false;
    const origin = this.conversations.get(originKey);
    const clean = origin ? scrubUnverifiedLinks(text, origin.recentToolText(), origin.knownText()) : text;
    // Sent on behalf of whoever caused it (a stranger's agent asking, say), so the outbox and the audit log see the real sender.
    const { principal, ...rest } = opts;
    await this.sendToOwner(clean, principal ?? this.ownerPrincipal(), originKey, rest);
    return true;
  }

  /**
   * Owner messages go to the owner's last live text thread, else to their first phone by
   * iMessage, else to their last email thread. Group threads are never used for this.
   */
  private async sendToOwner(text: string, principal: Principal, originKey: string, opts: { approvalToken?: string } = {}): Promise<void> {
    const mergeMs = this.deps.ownerMergeMs ?? 0;
    if (mergeMs <= 0) return this.sendToOwnerNow(text, principal, originKey, opts);
    // Several agents answering within seconds, or one run narrating its progress, must not become a
    // run of bubbles: collect what arrives inside the window and send it as one text.
    if (this.ownerQueue) {
      const q = this.ownerQueue;
      q.texts.push(text);
      q.principal = principal;
      q.originKey = originKey;
      if (opts.approvalToken) q.approvalToken = opts.approvalToken;
      return q.done;
    }
    const q: OwnerQueue = { texts: [text], principal, originKey, done: Promise.resolve(), ...(opts.approvalToken ? { approvalToken: opts.approvalToken } : {}) };
    q.done = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.ownerQueue = undefined;
        const merged = mergeOwnerTexts(q.texts);
        this.sendToOwnerNow(merged, q.principal, q.originKey, q.approvalToken ? { approvalToken: q.approvalToken } : {})
          .catch(() => undefined)
          .finally(resolve);
      }, mergeMs);
      (timer as { unref?: () => void }).unref?.();
    });
    this.ownerQueue = q;
    return q.done;
  }

  private async sendToOwnerNow(text: string, principal: Principal, originKey: string, opts: { approvalToken?: string; fromHold?: boolean } = {}): Promise<void> {
    // At night a text from another agent waits for the morning unless the owner is up and texting.
    if (!opts.fromHold && this.inQuietHours() && !this.ownerAwake()) {
      const held = this.deps.state.readJson<Array<{ text: string; at: string; approvalToken?: string }>>(QUIET_HOLD_FILE, []);
      held.push({ text, at: this.now().toISOString(), ...(opts.approvalToken ? { approvalToken: opts.approvalToken } : {}) });
      this.deps.state.writeJson(QUIET_HOLD_FILE, held);
      this.deps.audit.append({ kind: "outbound", conversationKey: originKey, principal: principal.id, detail: { held: "quiet-hours", chars: text.length } });
      return;
    }
    const last = this.ownerLast;
    const phone = this.deps.config.owner.phones[0];
    let out: OutboundMessage;
    if (last && (last.channel === "imessage" || last.channel === "sms")) {
      out = { channel: last.channel, conversationKey: last.conversationKey, text };
    } else if (phone) {
      out = { channel: "imessage", to: phone, text };
    } else if (last && DELIVERABLE.has(last.channel) && last.channel !== "a2a") {
      out = { channel: last.channel as OutboundChannel, conversationKey: last.conversationKey, text };
    } else if (last && last.channel === "chat") {
      // An owner who only has the dashboard chat (no phone yet) still gets the question: it waits
      // in the chat buffer and comes back as `pending` on their next message.
      this.stash(last.conversationKey, text);
      this.deps.audit.append({ kind: "outbound", conversationKey: originKey, principal: principal.id, detail: { channel: "chat", conversationKey: last.conversationKey, chars: text.length, stashed: true } });
      // Queued is not seen: the owner's next message was typed before this text reached them,
      // so a bare "yes" in it answers something else. Once shown, the model sees it in its
      // prompt and settles the owner's answer with approval_settle.
      if (!opts.approvalToken) this.deps.approvals.clearPrompted();
      return;
    } else {
      this.deps.audit.append({ kind: "error", conversationKey: originKey, principal: principal.id, detail: { message: "No way to reach the owner: no phone and no prior conversation" } });
      return;
    }
    const sent = await this.safeSend(out, principal, originKey);
    if (!sent) return;
    if (opts.approvalToken) this.deps.approvals.markPrompted(opts.approvalToken);
    else this.deps.approvals.clearPrompted();
  }

  private async safeSend(out: OutboundMessage, principal: Principal, conversationKey: string): Promise<boolean> {
    try {
      await this.deps.outbox.send(out, { principal, conversationKey });
      // Recorded only once the carrier took it: a failed send must not suppress the retry.
      if (CARRIER_CHANNELS.has(out.channel) && out.conversationKey) this.lastDelivered.set(out.conversationKey, { text: out.text, seq: ++this.sendSeq });
      this.deps.audit.append({ kind: "outbound", conversationKey, principal: principal.id, detail: { channel: out.channel, to: out.to, conversationKey: out.conversationKey, chars: out.text.length } });
      return true;
    } catch (error) {
      this.auditError(conversationKey, principal, error);
      throw error;
    }
  }

  private replyText(value: { ok: true; reply: string } | { ok: false; error: unknown }, principal: Principal): string {
    if (value.ok) return value.reply;
    // The full detail is in the audit log (auditError); the owner gets a short human reason, never a JSON body.
    if (principal.kind === "owner") {
      const raw = errorMessage(value.error);
      // A spent model budget (account credits, or this agent's monthly spend limit on Maritime) stops every
      // turn until someone raises it or the month resets; "try again in a minute" would be untrue.
      if (BUDGET_EXHAUSTED_PATTERN.test(raw)) {
        return budgetExhaustedReply(this.deps.config.features.budgetContact);
      }
      const reason = shortReason(raw);
      return `Hit a snag on my end${reason ? ` (${reason})` : ""}. Give me a minute and try that again.`;
    }
    return "Sorry, I hit a problem. Please try again later.";
  }

  // -------------------------------------------------------------------------
  // Prompt and tools
  // -------------------------------------------------------------------------

  private systemPromptFor(conv: Conversation): string {
    const { config, state, memory, approvals, skillsPrompt, policy } = this.deps;
    const principal = conv.principal;
    const tools = conv.agent.state.tools;
    const groups = new Set<string>();
    const capabilities = new Set<Capability>();
    for (const t of tools) {
      const meta = this.deps.registry.meta(t.name);
      if (!meta) continue;
      groups.add(meta.group);
      for (const c of meta.capabilities) if (policy.canEver(principal, c)) capabilities.add(c);
    }
    const pending = approvals.pending().filter((a) => (principal.kind === "owner" && principal.tier === "owner") || a.conversationKey === conv.key);
    const extra = [...(this.deps.promptExtra?.(principal, conv.channel) ?? [])];
    const upcoming = this.deps.meetings?.upcoming() ?? [];
    const meetingText = principal.kind === "owner" ? meetingsSection(upcoming, config.owner.timezone) : principal.kind === "agent" ? busySection(upcoming, config.owner.timezone) : undefined;
    if (meetingText) extra.push(meetingText);
    return buildSystemPrompt({
      config,
      principal,
      channel: conv.channel,
      now: this.now(),
      capabilities: [...capabilities],
      toolGroups: [...groups],
      memoryDigest: this.memoryDigestFor(principal),
      // Read fresh each time so `instinct persona set` applies on the next message.
      persona: readPersona(state),
      instructions: readAgentsInstructions(state),
      skillsPrompt: typeof skillsPrompt === "function" ? skillsPrompt(principal) : skillsPrompt,
      pendingApprovals: pending,
      setup: this.deps.setupSummary?.(),
      extra,
    });
  }

  /**
   * Memory is the owner's private notebook. The owner in their own thread gets the whole
   * digest. Anyone whose tier may know the owner's preferences gets the Preferences section
   * only, and nobody else gets anything.
   */
  private memoryDigestFor(principal: Principal): string {
    const { memory, policy } = this.deps;
    if (principal.kind === "owner" && principal.tier === "owner") return memory.digest(4000, this.now());
    const permission = policy.permissionFor(principal.tier, "owner.profile.preferences");
    if (permission !== "yes" && permission !== "partial") return "";
    const prefs = memory.preferencesDigest(permission === "yes" ? 1500 : 600);
    if (!prefs) return "";
    const scope = permission === "yes" ? "They may know most of these." : "Share only general, harmless preferences from this list; keep anything personal, medical or financial to yourself.";
    return `## ${this.deps.config.owner.name}'s preferences (tier ${principal.tier})\n${scope}\n${prefs}`;
  }

  private bindTools(conv: Conversation): AgentTool<any>[] {
    const { registry, policy } = this.deps;
    const ctx: ToolContext = {
      get principal() {
        return conv.principal;
      },
      conversationKey: conv.key,
      get deliveryKey() { return conv.deliveryKey; },
      get replyRef() { return conv.replyRef; },
      assertA2AActive: () => this.assertA2AActive(conv),
      markA2AState: (state) => {
        if (conv.replyRef.taskId) this.a2aStore.recordTask({ taskId: conv.replyRef.taskId, state });
      },
      channel: conv.channel,
      get ownerTurn() { return conv.ownerTurn; },
      now: this.now,
    };
    const visible = (t: RegisteredTool) => t.spec.meta.capabilities.every((c) => policy.canEver(conv.principal, c));
    const bound = registry.bind(ctx, visible);
    if (bound.length <= MAX_MODEL_TOOLS) return bound;
    // Proxies refuse a request with more tools than this and the whole agent goes dark; the
    // registry lists core, messaging and network tools before app tools, so the tail is cut.
    this.deps.audit.append({ kind: "error", conversationKey: conv.key, principal: conv.principal.id, detail: { message: `${bound.length} tools bound; keeping the first ${MAX_MODEL_TOOLS}` } });
    return bound.slice(0, MAX_MODEL_TOOLS);
  }

  /**
   * In a group thread every reply is visible to everyone, so the owner acts at the lowest
   * tier present. Unknown participants are strangers; an unknown member list caps to stranger.
   */
  private capForGroup(sender: Principal, msg: InboundMessage): Principal {
    const ownerPhones = new Set(this.deps.config.owner.phones.map(normalizePhone));
    const participants = Array.isArray(msg.meta?.participants) ? (msg.meta!.participants as unknown[]).filter((p): p is string => typeof p === "string") : [];
    let lowest: Tier = sender.tier;
    let others = 0;
    for (const raw of participants) {
      const phone = normalizePhone(raw);
      if (!phone || ownerPhones.has(phone)) continue;
      others++;
      const tier = this.deps.contacts.findByPhone(phone)?.tier ?? "stranger";
      if (TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(lowest)) lowest = tier;
    }
    if (others === 0) lowest = "stranger";
    return { ...sender, tier: lowest, cappedFrom: sender.tier };
  }

  // -------------------------------------------------------------------------
  // Small persisted bookkeeping
  // -------------------------------------------------------------------------

  private seenBefore(id: string): boolean {
    const seen = this.deps.state.readJson<string[]>(SEEN_FILE, []);
    return seen.includes(id);
  }

  private markSeen(id: string): void {
    const seen = this.deps.state.readJson<string[]>(SEEN_FILE, []);
    if (seen.includes(id)) return;
    seen.push(id);
    this.deps.state.writeJson(SEEN_FILE, seen.slice(-SEEN_IDS_MAX));
  }

  private rememberConversation(conv: Conversation): void {
    const map = this.deps.state.readJson<Record<string, unknown>>(CONVERSATIONS_FILE, {});
    const record: ConversationRecord = { principal: conv.principal, deliveryKey: conv.deliveryKey, replyRef: conv.replyRef };
    map[conv.key] = record;
    this.deps.state.writeJson(CONVERSATIONS_FILE, map);
  }

  private recallRecord(key: string): ConversationRecord | undefined {
    const raw = this.deps.state.readJson<Record<string, unknown>>(CONVERSATIONS_FILE, {})[key];
    if (!raw || typeof raw !== "object") return undefined;
    const o = raw as Record<string, unknown>;
    // Older files stored the bare Principal.
    if (typeof o.kind === "string" && typeof o.id === "string") return { principal: o as unknown as Principal, deliveryKey: key };
    if (!o.principal || typeof o.principal !== "object") return undefined;
    return {
      principal: o.principal as Principal,
      deliveryKey: typeof o.deliveryKey === "string" ? o.deliveryKey : key,
      ...(o.replyRef && typeof o.replyRef === "object" ? { replyRef: o.replyRef as ReplyRef } : {}),
    };
  }

  private rememberApproved(approval: Approval): void {
    const list = this.deps.state.readJson<ApprovedRecord[]>(APPROVED_FILE, []);
    list.push({ ...approval, status: "approved", approvedAt: this.now().toISOString() });
    this.deps.state.writeJson(APPROVED_FILE, list);
  }

  /**
   * Find and remove one approved request that covers this exact call: same conversation,
   * same requester, same capability, same tool and the same arguments, approved within
   * APPROVAL_USE_WINDOW_MS. Amounts may not exceed what was approved by more than 5%.
   * Stale entries are swept on every call.
   */
  private consumeApproval(call: { conversationKey: string; requestedBy: string; capability: Capability; toolName: string; argsHash: string; amountUsd: number | undefined }): Approval | undefined {
    const nowMs = this.now().getTime();
    const list = this.deps.state.readJson<ApprovedRecord[]>(APPROVED_FILE, []);
    const fresh = list.filter((a) => Date.parse(a.approvedAt ?? a.createdAt) + APPROVAL_USE_WINDOW_MS > nowMs);
    const index = fresh.findIndex(
      (a) =>
        a.conversationKey === call.conversationKey &&
        a.requestedBy === call.requestedBy &&
        a.capability === call.capability &&
        a.toolName === call.toolName &&
        a.argsHash === call.argsHash &&
        (call.amountUsd === undefined ? a.amountUsd === undefined : a.amountUsd !== undefined && call.amountUsd <= a.amountUsd * 1.05),
    );
    const match = index >= 0 ? fresh[index] : undefined;
    if (match) fresh.splice(index, 1);
    if (match || fresh.length !== list.length) this.deps.state.writeJson(APPROVED_FILE, fresh);
    return match;
  }

  /** Replies that could not be delivered (dashboard chat) wait here for the next turn on that key. */
  private stash(key: string, text: string): void {
    const all = this.deps.state.readJson<Record<string, string[]>>(PENDING_REPLIES_FILE, {});
    (all[key] ??= []).push(text);
    this.deps.state.writeJson(PENDING_REPLIES_FILE, all);
  }

  private takeStash(key: string): string[] {
    const all = this.deps.state.readJson<Record<string, string[]>>(PENDING_REPLIES_FILE, {});
    const texts = all[key];
    if (!texts || texts.length === 0) return [];
    delete all[key];
    this.deps.state.writeJson(PENDING_REPLIES_FILE, all);
    return texts;
  }

  /** Local hour in the owner's time zone. */
  private ownerLocalHour(): number {
    const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: this.deps.config.owner.timezone }).formatToParts(this.now());
    return Number(parts.find((p) => p.type === "hour")?.value ?? "12") % 24;
  }

  private inQuietHours(): boolean {
    const configured = this.deps.config.features.quietHours;
    if (configured === false) return false;
    const h = this.ownerLocalHour();
    const { start, end } = configured ?? QUIET_HOURS;
    return start > end ? h >= start || h < end : h >= start && h < end;
  }

  /** True when the owner texted any thread within OWNER_AWAKE_MS. */
  private ownerAwake(): boolean {
    const all = this.deps.state.readJson<Record<string, string>>(LAST_OWNER_TURN_FILE, {});
    const latest = Math.max(0, ...Object.values(all).map((t) => Date.parse(t) || 0));
    return this.now().getTime() - latest < OWNER_AWAKE_MS;
  }

  /** Texts held overnight, taken out of the hold. */
  takeQuietHold(): Array<{ text: string; approvalToken?: string }> {
    const held = this.deps.state.readJson<Array<{ text: string; at: string; approvalToken?: string }>>(QUIET_HOLD_FILE, []);
    if (held.length === 0) return [];
    this.deps.state.writeJson(QUIET_HOLD_FILE, []);
    return held;
  }

  /**
   * Every few minutes: once the owner's morning starts, deliver what waited overnight as one
   * text; and nudge any peer agent that has sat on the owner's ask for hours.
   */
  async housekeeping(): Promise<void> {
    if (!this.inQuietHours() || this.ownerAwake()) {
      const held = this.takeQuietHold();
      if (held.length > 0) {
        const text = held.length === 1 ? held[0]!.text : `While you were asleep:\n\n${held.map((h) => h.text).join("\n\n")}`;
        const token = held.map((h) => h.approvalToken).filter((t): t is string => Boolean(t)).at(-1);
        await this.sendToOwnerNow(text, this.ownerPrincipal(), "system:quiet-hours", { fromHold: true, ...(token ? { approvalToken: token } : {}) });
      }
    }
    await this.nudgeStaleAsks();
  }

  /** Owner-initiated asks that no peer answered within STALE_ASK_MS, each nudged once. */
  staleAsks(): A2ADelegation[] {
    const all = this.deps.state.readJson<Record<string, A2ADelegation>>("a2a-delegations.json", {});
    const nudged = this.deps.state.readJson<Record<string, string>>(NUDGED_FILE, {});
    const now = this.now().getTime();
    return Object.values(all).filter((d) => {
      if (d.principal.kind !== "owner" || !d.at || nudged[d.messageId]) return false;
      if (now - Date.parse(d.at) < STALE_ASK_MS) return false;
      const task = d.taskId ? this.a2aStore.task(d.taskId) : undefined;
      return !task || !a2aTerminal(task.state);
    });
  }

  private async nudgeStaleAsks(): Promise<void> {
    if (this.inQuietHours() && !this.ownerAwake()) return;
    const nudged = this.deps.state.readJson<Record<string, string>>(NUDGED_FILE, {});
    for (const d of this.staleAsks().slice(0, 3)) {
      nudged[d.messageId] = this.now().toISOString();
      this.deps.state.writeJson(NUDGED_FILE, nudged);
      const hours = Math.max(1, Math.round((this.now().getTime() - Date.parse(d.at!)) / 3_600_000));
      const about = d.summary ? ` about "${d.summary}"` : "";
      const task = d.taskId ? ` (taskId ${d.taskId})` : "";
      await this.runSystemTask({
        id: `nudge-${d.messageId}`,
        name: "nudge a silent agent",
        quiet: true,
        prompt: `Your ask to ${d.peer}${about}, sent ${hours} hours ago, has had no answer. Send that agent one short nudge with ask_instinct${task}: say you are still hoping to hear back and repeat the one concrete time and place you proposed. Then tell the owner in one line that there is no word yet from that person's agent and you nudged it. Do not ask the owner anything.`,
      }).catch(() => undefined);
    }
  }

  private readonly peerArrivals = new Map<string, number[]>();
  /** True once a peer has sent more than A2A_PEER_HOURLY_LIMIT messages in the last hour. */
  private peerOverLimit(peer: string, now: number): boolean {
    const recent = (this.peerArrivals.get(peer) ?? []).filter((t) => now - t < 3_600_000);
    // A dropped message does not count: otherwise a busy pair stays locked out for the whole hour.
    if (recent.length >= A2A_PEER_HOURLY_LIMIT) {
      this.peerArrivals.set(peer, recent);
      return true;
    }
    recent.push(now);
    this.peerArrivals.set(peer, recent);
    return false;
  }

  /**
   * The ceiling is for agents that flood; it dropped real negotiations in testing (3-way invites
   * and 13 of 18 cancel notices between partners). Replies to the owner's own asks, and any peer
   * the owner asked something, are never limited.
   */
  private peerExempt(msg: InboundMessage, principal: Principal): boolean {
    const taskId = msg.replyRef?.taskId;
    if (taskId && this.a2aStore.delegation(taskId)) return true;
    const handle = principal.agentHandle ?? msg.from;
    return Boolean(handle && this.a2aStore.ownerAsksTo(handle).length > 0);
  }


  /** Replies waiting for the next turn on a key, without taking them. */
  pendingReplies(key: string): string[] {
    return this.deps.state.readJson<Record<string, string[]>>(PENDING_REPLIES_FILE, {})[key] ?? [];
  }

  private strangerDay(): { day: string; record: StrangerDay; save: () => void } {
    const day = localDay(this.now(), this.deps.config.owner.timezone);
    const all = this.deps.state.readJson<Record<string, StrangerDay>>(STRANGERS_FILE, {});
    const record = all[day] ?? { conversations: {}, relays: 0 };
    return {
      day,
      record,
      save: () => this.deps.state.writeJson(STRANGERS_FILE, { [day]: record }),
    };
  }

  private strangerLimit(conversationKey: string, limits: { conversationsPerDay: number; messagesPerConversation: number }): string | undefined {
    const { record, save } = this.strangerDay();
    const count = record.conversations[conversationKey] ?? 0;
    if (count === 0 && Object.keys(record.conversations).length >= limits.conversationsPerDay) {
      return `stranger limit: ${limits.conversationsPerDay} new conversations per day`;
    }
    if (count >= limits.messagesPerConversation) {
      return `stranger limit: ${limits.messagesPerConversation} messages per conversation`;
    }
    record.conversations[conversationKey] = count + 1;
    save();
    return undefined;
  }

  private strangerRelayLimit(limits: { conversationsPerDay: number }): string | undefined {
    const { record, save } = this.strangerDay();
    if (record.relays >= limits.conversationsPerDay) {
      return `Blocked: strangers may leave at most ${limits.conversationsPerDay} messages for the owner per day.`;
    }
    record.relays += 1;
    save();
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

export function readSession(file: string): AgentMessage[] {
  if (!existsSync(file)) return [];
  const out: AgentMessage[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AgentMessage;
      if (parsed && typeof parsed === "object" && "role" in parsed) out.push(parsed);
    } catch {
      // A torn write leaves a partial last line; skipping it is the right recovery.
    }
  }
  return out;
}

export function writeSession(file: string, messages: AgentMessage[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const lines = messages.filter((m) => m.role !== "system").map((m) => JSON.stringify(m));
  writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "");
}

/**
 * Rebuild a context from stored messages: drop system messages (rebuilt per run), drop a
 * trailing tool call that never got its result, keep the last SESSION_KEEP_MESSAGES (and
 * no more than SESSION_KEEP_CHARS of JSON) and fold everything older into one plain-text
 * summary message. Idempotent on an already folded transcript.
 */
export function restoreMessages(stored: AgentMessage[], now: Date, keep = SESSION_KEEP_MESSAGES, maxChars = SESSION_KEEP_CHARS, keepImages = KEEP_RECENT_IMAGES): AgentMessage[] {
  const messages = dropOldImages(dropOrphanToolCalls(stored.filter((m) => m.role !== "system")), keepImages);
  let start = messages.length <= keep ? 0 : nextUserTurn(messages, messages.length - keep);
  // Large tool results can blow the context long before the message count does. The slice
  // only ever moves to a user or assistant turn; when none is left it stays where it is,
  // even above budget, because a slice that starts at a tool result is rejected outright.
  while (start < messages.length - 1 && charSize(messages.slice(start)) > maxChars) {
    const next = nextUserTurn(messages, start + 1);
    if (next >= messages.length || next === start) break;
    start = next;
  }
  if (start <= 0) return messages;

  const older = messages.slice(0, start);
  const summary: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: summarizeMessages(older) }],
    timestamp: now.getTime(),
  };
  return [summary, ...messages.slice(start)];
}

/**
 * The live context before a model call: the system message stays, the rest is folded like
 * a restore. The fold leaves room for the turn about to be added, so the transcript never
 * sits above SESSION_KEEP_MESSAGES + 2 (system message and summary) between turns.
 */
export function trimContext(messages: AgentMessage[], now: Date): AgentMessage[] {
  const system = messages.filter((m) => m.role === "system");
  const rest = restoreMessages(messages, now, SESSION_KEEP_MESSAGES - 2);
  return system.length ? [...system, ...rest] : rest;
}

/**
 * The kept slice must begin at a user turn so no tool result is left without its call. A
 * long tool loop (a browser session: screenshot, click, screenshot...) can run past the
 * window with no user turn at all; then the slice begins at the next assistant turn, which
 * the API also accepts, and never at a tool result, which it rejects. With nothing left to
 * land on this returns the end, and the caller keeps the slice where it is.
 */
function nextUserTurn(messages: AgentMessage[], from: number): number {
  let i = from;
  while (i < messages.length && messages[i]?.role !== "user") i++;
  if (i < messages.length) return i;
  let a = from;
  while (a < messages.length && messages[a]?.role !== "assistant") a++;
  return a;
}

/**
 * A screenshot is a few hundred thousand characters of base64, more than the whole char
 * budget, so a browser session would push the fold past every turn in one step. Older
 * screenshots are swapped for a one-line placeholder; the newest few stay, since the model
 * is looking at them. The text parts of the result are untouched.
 */
export function dropOldImages(messages: AgentMessage[], keepImages = KEEP_RECENT_IMAGES): AgentMessage[] {
  let seen = 0;
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "toolResult" || !m.content.some((c) => c.type === "image")) continue;
    seen++;
    if (seen <= keepImages) continue;
    out[i] = { ...m, content: m.content.map((c) => (c.type === "image" ? { type: "text" as const, text: "(an earlier screenshot, dropped to save space)" } : c)) };
  }
  return out;
}

function charSize(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    try {
      total += JSON.stringify(m).length;
    } catch {
      total += 1000;
    }
  }
  return total;
}

function dropOrphanToolCalls(messages: AgentMessage[]): AgentMessage[] {
  const resultIds = new Set<string>();
  for (const m of messages) if (m.role === "toolResult") resultIds.add(m.toolCallId);
  let end = messages.length;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const orphan = m.content.some((c) => c.type === "toolCall" && !resultIds.has(c.id));
    if (orphan) {
      end = i;
      break;
    }
  }
  return messages.slice(0, end);
}

function summarizeMessages(older: AgentMessage[]): string {
  const lines: string[] = [];
  for (const m of older) {
    if (m.role === "user") {
      const text = messageText(m.content);
      if (text) lines.push(`- user: ${clip(text, 200)}`);
    } else if (m.role === "assistant") {
      const text = messageText(m.content.filter((c) => c.type === "text"));
      const calls = m.content.filter((c) => c.type === "toolCall").map((c) => c.name);
      if (text) lines.push(`- assistant: ${clip(text, 200)}`);
      if (calls.length) lines.push(`- assistant used tools: ${calls.join(", ")}`);
    }
  }
  const body = clip(lines.join("\n"), 6000);
  return `[Conversation summary] ${older.length} earlier messages were trimmed to save space. Highlights:\n${body}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "Approve intro with Sam" reads as "intro with Sam" after "that's a yes". */
export function humanApprovalSummary(summary: string): string {
  return summary.trim().replace(/^approved?\s+/i, "").replace(/\.$/, "");
}

const LINK_RE = /https?:\/\/[^\s)<>"'\]]+/g;

/** Links in a tool result's text blocks. */
export function extractLinks(content: unknown): string[] {
  const out: string[] = [];
  const blocks = Array.isArray(content) ? content : [content];
  for (const b of blocks) {
    const text = typeof b === "string" ? b : b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "";
    for (const m of text.match(LINK_RE) ?? []) out.push(m.replace(/[.,;:!?]+$/, ""));
  }
  return out;
}

function userMessage(text: string, now: Date): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: now.getTime() };
}

function finalAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const text = messageText(m.content.filter((c) => c.type === "text")).trim();
    if (text) return text;
  }
  return "";
}

function runFailure(messages: AgentMessage[]): string | undefined {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (last && last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
    return last.errorMessage || `model run ${last.stopReason}`;
  }
  return undefined;
}

function messageText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

function contentPreview(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = messageText(content as Array<{ type: string; text?: string }>);
  return text ? clip(text, 300) : undefined;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeDescribe(meta: ToolMeta | undefined, args: unknown): string {
  try {
    const described = meta?.describe?.(args);
    if (described) return described;
  } catch {
    // A describe helper must never break the audit trail.
  }
  return clip(JSON.stringify(args ?? {}), 300);
}

/** Pick the capability the approval is about: the first one the tier does not get outright. */
function askedCapability(principal: Principal, meta: ToolMeta): Capability {
  const row = DEFAULT_TIER_TABLE[principal.tier];
  for (const cap of meta.capabilities) {
    const permission = row?.[cap];
    if (permission === "ask" || permission === "limit" || permission === "no") return cap;
  }
  return meta.capabilities[0] ?? "converse";
}

/** JSON with sorted keys, so two equal argument objects always hash the same. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}

/** The part of an error a person can use: no JSON bodies, no status-code prefixes, one short line. */
export function shortReason(message: string): string {
  // A proxy or gateway error page is noise to the owner ("Hit a snag (<!DOCTYPE html>)").
  if (/<!doctype|<html|<head|<body/i.test(message)) return "";
  let m = message.split(/[{\n]/)[0] ?? "";
  m = m.replace(/^\s*\d{3}:?\s*/, "").replace(/[:\s]+$/, "").trim();
  if (m.length > 80) m = `${m.slice(0, 77).trim()}...`;
  return m;
}

export function hashArgs(args: unknown): string {
  return createHash("sha256").update(stableJson(args ?? {})).digest("hex").slice(0, 16);
}

function approvalText(approval: Approval, requester: Principal, config: InstinctConfig): string {
  const amount = approval.amountUsd !== undefined ? ` ($${approval.amountUsd.toFixed(2)})` : "";
  const who = requester.kind === "owner" ? "" : ` (asked by ${requester.displayName})`;
  // A plain question, no token and no protocol words: a bare yes or no settles it, anything else the model settles.
  // Policy prompts may already end with the question; strip it so it is asked exactly once.
  void config;
  const base = approval.summary.replace(/[\s.?!]*want me to go ahead\?\s*$/i, "").replace(/[\s.?!]+$/, "");
  return `${base}${amount}${who}. Want me to go ahead?`;
}

/** Lower-cased words only, so "Here you go." and "here you go" count as the same text. */
function normalizedText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).join(" ");
}

/**
 * One text out of several queued for the owner: exact and near repeats go, and an earlier text whose
 * words a later one mostly contains ("Sam's in." before "Sam's in. Pick a time...") goes with them.
 */
export function mergeOwnerTexts(texts: string[]): string {
  const words = (t: string) => new Set(normalizedText(t).split(" ").filter(Boolean));
  const keep: string[] = [];
  texts.forEach((t, i) => {
    const mine = words(t);
    if (mine.size === 0) return;
    const superseded = texts.slice(i + 1).some((later) => {
      const theirs = words(later);
      let hit = 0;
      for (const w of mine) if (theirs.has(w)) hit++;
      return hit / mine.size >= 0.7;
    });
    if (!superseded) keep.push(t.trim());
  });
  return keep.join("\n\n");
}

function untrustedLabel(msg: InboundMessage, principal: Principal): string {
  return `${msg.channel} from ${principal.displayName} (${principal.kind}, tier ${principal.tier})`;
}

/** One line per attachment. Names, types and links are sender-controlled, so they are flattened to one line each. */
function withAttachments(text: string, msg: InboundMessage): string {
  if (!msg.attachments?.length) return text;
  const flat = (v: string | undefined, max: number) => (v ? clip(v.replace(/[\r\n\[\]]+/g, " ").trim(), max) : "");
  const lines = msg.attachments.map((a) => {
    const name = flat(a.name, 200);
    const type = flat(a.mimeType, 80);
    const where = a.path ? ` path=${flat(a.path, 300)}` : a.url ? ` url=${a.url.replace(/[\r\n]+/g, "").trim()}` : "";
    return `[attachment${name ? ` ${name}` : ""}${type ? ` ${type}` : ""}${where}]`;
  });
  return `${text}\n${lines.join("\n")}`;
}

const DATA_PART_CAP = 6_000;

/** The structured data part of an A2A message, described when a describer is wired and always dumped as JSON. */
function withData(text: string, msg: InboundMessage, describe: RuntimeDeps["describeData"]): string {
  if (!msg.data || typeof msg.data !== "object") return text;
  const parts: string[] = [];
  if (describe) {
    try {
      const described = describe(msg.data);
      if (described?.trim()) parts.push(described.trim());
    } catch {
      // A describer that throws must not drop the message.
    }
  }
  let json: string;
  try {
    json = JSON.stringify(msg.data);
  } catch {
    json = "(unserializable data part)";
  }
  parts.push(`Structured data part (OIP):\n${clip(json, DATA_PART_CAP)}`);
  return `${text}\n\n${parts.join("\n")}`.trim();
}

const FILE_FENCE = /```maritime-file\n[^\n]*\n```/g;

function fileFencesIn(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const c of content as Array<{ type?: string; text?: string }>) if (c?.type === "text" && typeof c.text === "string") out.push(...(c.text.match(FILE_FENCE) ?? []));
  return out;
}

const SNAG = /^Hit a snag on my end\b[^\n]*Give me a minute and try that again\.?$/;

/**
 * Last pass over what the owner reads: an error notice next to a real answer, a repeated
 * paragraph (status lines stashed twice), and "Nothing new" sitting on top of the news.
 */
export function tidyOwnerReply(text: string): string {
  // The model sometimes drops a stray Armenian word into an English reply ("What's your email հասցե?").
  if (/[\u0530-\u058F]/.test(text) && (text.match(/[A-Za-z]/g)?.length ?? 0) > (text.match(/[\u0530-\u058F]/g)?.length ?? 0)) {
    text = text.replace(/[ \t]*[\u0530-\u058F]+[\u0530-\u058F'’-]*/g, "").replace(/ +([?.!,])/g, "$1");
  }
  let parts = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && parts.some((p) => !SNAG.test(p))) parts = parts.filter((p) => !SNAG.test(p));
  parts = parts.filter((p, i) => parts.indexOf(p) === i);
  // A link lead-in whose link never came ("Here's my LinkedIn:") reads as broken.
  const body = parts.join("\n\n").replace(/^[ \t]*(?:here'?s|here is|find|connect with)?[ \t]*(?:me|my)?[ \t]*(?:on[ \t]+)?linkedin[ \t]*[:：]?[ \t]*(?:\n|$)/gim, "").replace(/\n{3,}/g, "\n\n").trim();
  const lead = /^(?:nothing (?:else )?new(?: yet| since[^\n]*)?|no news yet)[.!]?[ \t]*(?:\n+|$)/i.exec(body);
  if (lead && body.slice(lead[0].length).trim()) return body.slice(lead[0].length).trim();
  return body;
}

/** Add back any file block a tool produced this turn that the reply left out. */
export function withFileFences(reply: string, fences: string[]): string {
  // The model may paste the block reformatted; the file's path is what identifies it.
  const pathOf = (f: string) => /"path":"([^"]+)"/.exec(f)?.[1];
  const missing = fences.filter((f) => !reply.includes(f) && !(pathOf(f) && reply.includes(pathOf(f)!)));
  return missing.length === 0 ? reply : [reply.trim(), ...missing].filter(Boolean).join("\n\n");
}

/**
 * An answer that missed its reply window shows up under a later message; without a label the owner
 * reads it as the answer to whatever they just asked.
 */
export function gapNoteText(gapMs: number): string {
  const hours = Math.round(gapMs / 3_600_000);
  return `[This message arrives about ${hours} hour${hours === 1 ? "" : "s"} after the previous one in this thread. Answer it on its own: do not bring back requests, confirmations or offers from before the gap unless this message asks about them. Old asks you never answered may be stale; if one still matters, mention it once in a line, not as a question that needs a yes.]`;
}

/** "grace-liu-wxd83" is "Grace Liu": the trailing random suffix is dropped. */
export function nameFromAgentHandle(handle: string): string {
  const parts = handle.replace(/^@/, "").split("-").filter(Boolean);
  if (parts.length > 1 && /^[a-z0-9]{4,6}$/.test(parts[parts.length - 1]!) && /\d/.test(parts[parts.length - 1]!)) parts.pop();
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ") || handle;
}

/**
 * Texts that waited for this turn, then the reply. A late answer was relayed by the run (notify_owner) and
 * stashed again, so the owner got it twice under an "About ..." label; a text the reply or an earlier one
 * already says is dropped.
 */
export function joinOwnerParts(waiting: Array<string | undefined>, reply: string | undefined): string {
  const body = (t: string) => t.replace(/^About "[^\n]*":\n/, "").replace(/\s+/g, " ").trim();
  const replyBody = reply ? body(reply) : "";
  const parts: string[] = [];
  for (const t of waiting) {
    if (!t) continue;
    const b = body(t);
    if (!b || (replyBody && replyBody.includes(b)) || parts.some((p) => body(p).includes(b))) continue;
    parts.push(t);
  }
  if (reply) parts.push(reply);
  return parts.join("\n\n");
}

/** A reply that opens by saying a message just went out ("Sent to Victor", "Told Nadia you're late", "I asked her agent"). */
export function claimsSend(reply: string): boolean {
  const first = reply.trim().split(/\n/)[0] ?? "";
  return /^(?:done[,.!:—\s-]+)?(?:i(?:'ve| have)? )?(?:sent|told|asked|messaged|pinged|passed (?:it|that|this) (?:on|along)|forwarded)\b(?![^.\n]{0,40}\b(?:earlier|before|already|this morning|yesterday)\b)/i.test(first);
}

export function lateAnswer(question: string | undefined, reply: string): string {
  const q = (question ?? "").replace(/\s+/g, " ").trim();
  // "About \"yes\":" labels nothing; only a real question is worth naming.
  if (!q || /^(yes|yeah|yep|no|nope|ok|okay|sure|thanks|thank you|y|n|k)[.!]?$/i.test(q)) return reply;
  const short = q.length > 60 ? `${q.slice(0, 57).trimEnd()}…` : q;
  return `About "${short}":\n${reply}`;
}

/** What a busy owner thread is doing, in words: "Still on your earlier request (about 6 min in, searching the web)." */
export function busyStatus(conv: { busySince: number | undefined; activity: string | undefined }, now: Date): string | undefined {
  if (conv.busySince === undefined) return undefined;
  const mins = Math.floor((now.getTime() - conv.busySince) / 60_000);
  const doing = activityPhrase(conv.activity);
  const parts = [mins >= 1 ? `about ${mins} min in` : undefined, doing].filter(Boolean).join(", ");
  return `Still on your earlier request${parts ? ` (${parts})` : ""}. Got this one too; I'll answer it right after.`;
}

function activityPhrase(tool: string | undefined): string | undefined {
  if (!tool) return undefined;
  if (/search/.test(tool)) return "searching the web";
  if (/fetch|browse/.test(tool)) return "reading a page";
  if (/computer|screenshot|click/.test(tool)) return "working in the browser";
  if (/pdf|image|file|write|edit/.test(tool)) return "putting the file together";
  if (/instinct|a2a/.test(tool)) return "waiting on another agent";
  if (/schedule/.test(tool)) return "setting reminders";
  if (/memory/.test(tool)) return "checking my notes";
  if (/bash|python|exec|run/.test(tool)) return "crunching it";
  if (/app_|composio|apps_/.test(tool)) return "working in your connected app";
  return undefined;
}

function ackText(channel: Channel): string {
  switch (channel) {
    case "email":
      return "Got it. I am on it and will reply by email when done.";
    case "chat":
      return "On it. This is taking a moment; send another message in a bit and I will have the answer here.";
    case "a2a":
      return "Working on it.";
    default:
      return "On it. I will text you when it is done.";
  }
}

function isGroup(msg: InboundMessage): boolean {
  return msg.meta?.isGroup === true;
}

/**
 * The runtime key for a message. A 1:1 thread is its own key. A group thread gets one key
 * per principal, so each participant has their own Agent and transcript while replies
 * still land in the shared thread.
 */
export function runtimeKey(msg: InboundMessage, principal: Principal): string {
  if (msg.channel === "a2a" && msg.replyRef.taskId) return `${msg.conversationKey}:task:${msg.replyRef.taskId}${msg.replyRef.messageId ? `:message:${msg.replyRef.messageId}` : ""}`;
  if (!isGroup(msg)) return msg.conversationKey;
  return `${msg.conversationKey}:${principal.id}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function channelOf(key: string): Channel {
  const prefix = key.slice(0, key.indexOf(":") > 0 ? key.indexOf(":") : key.length);
  return CHANNELS.has(prefix) ? (prefix as Channel) : "chat";
}

function localDay(now: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

type BudgetOutcome<T> = { state: "done"; value: T } | { state: "pending" };

function withinBudget<T>(promise: Promise<T>, budgetMs: number): Promise<BudgetOutcome<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ state: "pending" }), budgetMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve({ state: "done", value });
    });
  });
}

/** Context for the model: what the owner just saw above its reply (approval results, relayed news, questions). */
export function shownToOwnerNote(texts: string[]): string {
  return `[Shown to the owner just before this message, already delivered; build on it and do not contradict it:]\n${texts.map((t) => `- ${t.replace(/\s+/g, " ").trim()}`).join("\n")}`;
}

/** Trusted context for a request from an agent the owner had already asked this agent to reach. */
export function mutualAskNote(owner: string, peer: string, ask: { at?: string; summary?: string }): string {
  const what = ask.summary ? `: "${ask.summary.replace(/\s+/g, " ").trim()}"` : "";
  return `[From your own records, not from the sender: ${owner} already asked you to reach ${peer}${ask.at ? ` (${ask.at})` : ""}${what}. That request is ${owner}'s yes to meeting them and to a time within what ${owner} asked for. Accept with reply_instinct (intent complete, oipIntent accept, one concrete time and place) without asking ${owner} again, then tell ${owner} in one line who, when and where. Ask ${owner} only if the time clashes with something they told you.]`;
}

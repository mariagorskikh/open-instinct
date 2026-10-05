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
import type { ApprovalMatch, ApprovalStore } from "./approvals.js";
import type { AuditLog } from "./audit.js";
import type { ContactStore } from "./contacts.js";
import type { MemoryStore } from "./memory.js";
import { OwnerNotifier } from "./notifier.js";
import { DEFAULT_TIER_TABLE, SPEND_CAPABILITIES, type PolicyEngine } from "./policy.js";
import { normalizePhone, resolvePrincipal } from "./principal.js";
import { readAgentsInstructions, readPersona } from "./persona.js";
import { buildSystemPrompt, wrapUntrusted } from "./prompt.js";
import { A2AStore, a2aState, a2aTerminal } from "./a2a-state.js";
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
  config: InstinctConfig;
  policy: PolicyEngine;
  approvals: ApprovalStore;
  audit: AuditLog;
  scheduler: Scheduler;
  contacts: ContactStore;
  memory: MemoryStore;
  registry: ToolRegistry;
  model: Model<any>;
  outbox: Outbox;
  skillsPrompt?: string;
  streamFn?: StreamFn;
  now?: () => Date;
  replyBudgetMs?: number;
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
/** An approved request can be acted on for this long before it lapses. */
export const APPROVAL_USE_WINDOW_MS = 15 * 60 * 1000;
const SEEN_IDS_MAX = 500;
const DEFAULT_REPLY_BUDGET_MS = 20_000;
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
    this.repliedViaTool = false;
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
  private readonly now: () => Date;
  private readonly sessionsDir: string;
  private readonly notifier: OwnerNotifier;
  private readonly a2aStore: A2AStore;
  private readonly inboundRuns = new Map<string, Promise<HandleResult>>();
  private readonly inboundQueues = new Map<string, Promise<unknown>>();
  private readonly a2aAdmissions = new Map<string, Promise<unknown>>();
  private readonly backgroundReplies = new Set<string>();
  private ownerLast?: { conversationKey: string; channel: Channel };

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.sessionsDir = deps.sessionsDir ?? deps.state.path("sessions");
    deps.state.ensure();
    this.a2aStore = deps.a2aStore ?? new A2AStore(deps.state);
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

  async handleInbound(msg: InboundMessage, opts: { waitForCompletion?: boolean } = {}): Promise<HandleResult> {
    const originalPrincipal = resolvePrincipal(msg, this.deps.config, this.deps.contacts);
    const base = { principal: originalPrincipal, conversationKey: msg.conversationKey, acked: true as const };
    if (this.seenBefore(msg.id)) return { ...base, blocked: "duplicate" };
    if (msg.channel === "a2a" && msg.meta?.eventType === "a2a.task.canceled") {
      this.cancelA2A(msg);
      this.markSeen(msg.id);
      return { ...base, blocked: "canceled" };
    }
    let run = this.inboundRuns.get(msg.id);
    if (!run) {
      run = this.processInbound(msg);
      this.inboundRuns.set(msg.id, run);
      void run.finally(() => this.inboundRuns.delete(msg.id)).catch(() => undefined);
    }
    if (opts.waitForCompletion) return run;
    const outcome = await withinBudget(run.then((result) => ({ result }), (error: unknown) => ({ error })), this.deps.replyBudgetMs ?? DEFAULT_REPLY_BUDGET_MS);
    if (outcome.state !== "done") {
      this.backgroundReplies.add(msg.id);
      return { ...base, reply: ackText(msg.channel) };
    }
    if ("error" in outcome.value) throw outcome.value.error;
    return outcome.value.result;
  }

  private async processInbound(original: InboundMessage): Promise<HandleResult> {
    if (original.meta?.conversationScopeKnown === false) throw new Error("Conversation scope must be resolved before delivery");
    const processing = this.deps.state.readJson<string[]>(PROCESSING_FILE, []);
    if (processing.includes(original.id)) throw new InboundUncertainError(original.id);
    const prepared = await this.prepareA2A(original);
    if (!prepared) {
      this.markSeen(original.id);
      return { acked: true, principal: resolvePrincipal(original, this.deps.config, this.deps.contacts), conversationKey: original.conversationKey, blocked: "inactive-task" };
    }
    const { msg, principal, key } = prepared;
    const queueKey = key ?? runtimeKey(msg, principal ?? resolvePrincipal(msg, this.deps.config, this.deps.contacts));
    const before = this.inboundQueues.get(queueKey) ?? Promise.resolve();
    const work = before.catch(() => undefined).then(async () => {
      if (this.seenBefore(original.id)) return { acked: true as const, principal: principal ?? resolvePrincipal(msg, this.deps.config, this.deps.contacts), conversationKey: msg.conversationKey, blocked: "duplicate" };
      const active = this.deps.state.readJson<string[]>(PROCESSING_FILE, []);
      this.deps.state.writeJson(PROCESSING_FILE, [...active, original.id]);
      try {
        const result = await this.runInbound(msg, principal, key);
        if (this.backgroundReplies.delete(original.id) && !DELIVERABLE.has(msg.channel) && result.reply) this.stash(queueKey, result.reply);
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

  private async runInbound(msg: InboundMessage, routedPrincipal?: Principal, routedKey?: string): Promise<HandleResult> {
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
      detail: { id: msg.id, channel: msg.channel, from: msg.from, chars: msg.text.length, source: msg.source, ...(group ? { group: true, tier: principal.tier } : {}) },
    });

    if (principal.kind === "stranger") {
      const limit = this.strangerLimit(msg.conversationKey, policy.toJSON().strangerLimits);
      if (limit) {
        audit.append({ kind: "policy", conversationKey: msg.conversationKey, principal: principal.id, detail: { blocked: limit } });
        return { ...base, acked: true, blocked: limit };
      }
    }

    let text = msg.text;
    let approvalNote: string | undefined;
    if (principal.kind === "owner" && !group && !msg.meta?.delegatedResult) {
      if (DELIVERABLE.has(msg.channel) && msg.channel !== "a2a") {
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
    const prompt = principal.kind === "owner" && !msg.meta?.delegatedResult ? body : wrapUntrusted(body, untrustedLabel(msg, principal));
    const conv = this.conversation(routedKey ?? runtimeKey(msg, principal), principal, { deliveryKey: msg.conversationKey, replyRef: msg.replyRef });
    if (conv.channel === "a2a" && !this.a2aStore.active(conv.replyRef.taskId ?? "", conv.replyRef.messageId)) return { ...base, acked: true, blocked: "inactive-task" };
    const stashed = this.takeStash(conv.key);
    const joinReply = (reply: string | undefined) => [approvalNote, ...stashed, reply].filter((t): t is string => Boolean(t)).join("\n\n") || undefined;

    if (conv.busy) {
      conv.steer(prompt);
      return { ...base, acked: true, reply: joinReply(undefined) };
    }

    // Typing is a courtesy, never a cost: it runs alongside the model and is dropped when slow.
    if (DELIVERABLE.has(msg.channel) && this.deps.outbox.typing) {
      void withinBudget(this.deps.outbox.typing(msg.conversationKey).catch(() => undefined), TYPING_TIMEOUT_MS);
    }

    const promptedBefore = approvals.promptedToken();
    const run = conv.run(prompt).then(
      (reply) => ({ ok: true as const, reply }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const outcome = await run;
    const reply = this.replyText(outcome, principal);
    if (!outcome.ok) this.auditError(conv.key, principal, outcome.error);
    if (DELIVERABLE.has(msg.channel) && reply) await this.deliver(conv, reply, { keepPrompt: approvals.promptedToken() !== promptedBefore });
    return { ...base, acked: true, reply: joinReply(reply) };
  }

  /** Scheduled jobs run as the owner in their own conversation; results go to the owner's phone. */
  async runScheduled(entry: ScheduleEntry): Promise<void> {
    const principal = this.ownerPrincipal();
    const key = `scheduled:${entry.id}`;
    const conv = this.conversation(key, principal);
    this.deps.audit.append({ kind: "schedule", conversationKey: key, principal: principal.id, detail: { id: entry.id, name: entry.name, fired: true } });
    let text = "";
    try {
      text = await conv.run(entry.prompt);
    } catch (error) {
      this.auditError(key, principal, error);
      return;
    }
    if (!text.trim()) return;
    await this.sendToOwner(text, principal, key);
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
    audit.append({ kind: "tool_call", conversationKey: conv.key, principal: conv.principal.id, detail });
    if (toolName === REPLY_TOOL && !isError) conv.repliedViaTool = true;
    if (isError || meta?.recordsOwnSpend) return;
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

    // A relay approval (ask_owner) informs the model through the follow-up only; it never
    // pre-authorises a policy ask.
    if (match.approved && resolved.capability !== "owner.relay") this.rememberApproved(resolved);

    const note = `${match.approved ? "Approved" : "Denied"}: ${resolved.summary}`;
    await this.resumeConversation(resolved.conversationKey, `Owner ${verb}: ${resolved.summary}`);

    if (DELIVERABLE.has(msg.channel)) {
      await this.safeSend({ channel: msg.channel as OutboundChannel, conversationKey: msg.conversationKey, text: note, replyRef: msg.replyRef }, principal, msg.conversationKey);
    }
    return note;
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
  private async deliver(conv: Conversation, text: string, opts: { keepPrompt?: boolean } = {}): Promise<void> {
    const channel = conv.channel;
    if (channel === "scheduled" || channel === "system") return;
    if (!DELIVERABLE.has(channel)) {
      this.stash(conv.key, text);
      return;
    }
    const out: OutboundMessage = { channel: channel as OutboundChannel, conversationKey: conv.deliveryKey, text, replyRef: conv.replyRef };
    if (channel === "a2a") {
      if (conv.repliedViaTool) return;
      if (!this.a2aStore.active(conv.replyRef.taskId ?? "", conv.replyRef.messageId)) return;
      try { await this.assertA2AActive(conv); } catch (error) { if (error instanceof A2AInactiveError) return; throw error; }
      const taskId = conv.replyRef.taskId;
      if (!taskId) {
        this.deps.audit.append({ kind: "error", conversationKey: conv.key, principal: conv.principal.id, detail: { message: "A2A reply dropped: no task id on record" } });
        return;
      }
      const waiting = this.deps.approvals.pending().some((a) => a.conversationKey === conv.key);
      out.a2a = { taskId, intent: waiting ? "progress" : "complete" };
    }
    // A reply to the owner changes what their next bare "yes" is about, unless this run raised the question.
    if (conv.principal.kind === "owner" && !opts.keepPrompt) this.deps.approvals.clearPrompted();
    await this.safeSend(out, conv.principal, conv.key);
    if (out.a2a && out.a2a.intent === "complete") this.a2aStore.recordTask({ taskId: out.a2a.taskId, state: "completed" });
  }

  /**
   * Owner messages go to the owner's last live text thread, else to their first phone by
   * iMessage, else to their last email thread. Group threads are never used for this.
   */
  private async sendToOwner(text: string, principal: Principal, originKey: string, opts: { approvalToken?: string } = {}): Promise<void> {
    const last = this.ownerLast;
    const phone = this.deps.config.owner.phones[0];
    let out: OutboundMessage;
    if (last && (last.channel === "imessage" || last.channel === "sms")) {
      out = { channel: last.channel, conversationKey: last.conversationKey, text };
    } else if (phone) {
      out = { channel: "imessage", to: phone, text };
    } else if (last && DELIVERABLE.has(last.channel) && last.channel !== "a2a") {
      out = { channel: last.channel as OutboundChannel, conversationKey: last.conversationKey, text };
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
      this.deps.audit.append({ kind: "outbound", conversationKey, principal: principal.id, detail: { channel: out.channel, to: out.to, conversationKey: out.conversationKey, chars: out.text.length } });
      return true;
    } catch (error) {
      this.auditError(conversationKey, principal, error);
      throw error;
    }
  }

  private replyText(value: { ok: true; reply: string } | { ok: false; error: unknown }, principal: Principal): string {
    if (value.ok) return value.reply;
    if (principal.kind === "owner") return `Something went wrong: ${errorMessage(value.error)}`;
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
    const extra = this.deps.promptExtra?.(principal, conv.channel) ?? [];
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
      skillsPrompt,
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
      now: this.now,
    };
    const visible = (t: RegisteredTool) => t.spec.meta.capabilities.every((c) => policy.canEver(conv.principal, c));
    return registry.bind(ctx, visible);
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
export function restoreMessages(stored: AgentMessage[], now: Date, keep = SESSION_KEEP_MESSAGES, maxChars = SESSION_KEEP_CHARS): AgentMessage[] {
  const messages = dropOrphanToolCalls(stored.filter((m) => m.role !== "system"));
  let start = messages.length <= keep ? 0 : nextUserTurn(messages, messages.length - keep);
  // Large tool results can blow the context long before the message count does.
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

/** The kept slice must begin at a user turn so no tool result is left without its call. */
function nextUserTurn(messages: AgentMessage[], from: number): number {
  let i = from;
  while (i < messages.length && messages[i]?.role !== "user") i++;
  return i >= messages.length ? from : i;
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

export function hashArgs(args: unknown): string {
  return createHash("sha256").update(stableJson(args ?? {})).digest("hex").slice(0, 16);
}

function approvalText(approval: Approval, requester: Principal, config: InstinctConfig): string {
  const who = requester.kind === "owner" ? "" : ` (asked by ${requester.displayName})`;
  const amount = approval.amountUsd !== undefined ? ` ($${approval.amountUsd.toFixed(2)})` : "";
  return `${approval.summary}${amount}${who}. Reply YES or NO. Token ${approval.token}. From ${config.agent.name}.`;
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

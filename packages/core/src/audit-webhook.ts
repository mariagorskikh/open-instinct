/**
 * Audit webhook: a signed copy of each audit entry, posted to one URL the owner chose, such as a
 * monitoring service, an insurer or their own server. Off until the owner connects one.
 *
 * Each POST body is JSON: { id, source, agent, entry }. The signature header is
 * `X-Instinct-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`, keyed with the shared
 * secret (the GitHub and Hermes webhook scheme), so the receiver can reject forged copies.
 *
 * A copy carries facts, not content: tool result previews, phone numbers, email addresses and
 * conversation keys stay home. A tool call carries the policy decision that let it run (allowed,
 * allowed through a grant, or approved by the owner), so the receiver can tell on whose authority
 * the agent acted.
 *
 * Delivery is in order, one copy at a time, with a few retries. Copies that still fail wait in
 * audit-webhook-outbox.jsonl (capped) and go out ahead of the next new entry.
 */
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { AuditLog } from "./audit.js";
import { checkPublicTarget, type Lookup } from "./net-guard.js";
import type { StateDir } from "./state.js";
import { defineTool, textResult, type RegisteredTool } from "./tools.js";
import type { AuditEntry, AuditKind } from "./types.js";

export const AUDIT_WEBHOOK_FILE = "secrets/audit-webhook.json";
export const AUDIT_WEBHOOK_OUTBOX = "audit-webhook-outbox.jsonl";
export const AUDIT_SIGNATURE_HEADER = "X-Instinct-Signature-256";
const OUTBOX_CAP = 1000;
const TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAYS_MS = [1000, 5000];
/** Detail keys that can hold content or contact details. Never copied out. */
const DROPPED_KEYS = new Set(["result", "from", "to", "phone", "email", "conversationKey", "text"]);

export interface AuditWebhookSettings {
  url: string;
  secret: string;
  connectedAt: string;
}

/** The policy decision behind a tool call, as the receiver sees it. */
export interface AuditDecision {
  outcome: string;
  /** The owner said yes to this exact call. */
  approved?: boolean;
  /** A standing grant covered it. */
  viaGrant?: string;
}

export interface AuditCopy {
  id: string;
  source: "open-instinct";
  agent: string;
  model?: string;
  entry: {
    at: string;
    kind: AuditKind;
    /** owner, contact, stranger or system: never a phone number. */
    principal?: string;
    tier?: string;
    /** A hash of the conversation key: groups entries without revealing who was talking. */
    conversation?: string;
    detail: Record<string, unknown>;
    decision?: AuditDecision;
  };
}

export interface AuditWebhookOptions {
  state: StateDir;
  /** Who is sending: the agent's handle or name. */
  agent: string;
  /** The model the runtime runs (provider/id), so the receiver need not take the agent's word for it. */
  model?: string;
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  /** The trust tier behind a principal id (owner, partner, friend...), when known. */
  tierOf?: (principal: string) => string | undefined;
  logger?: (message: string) => void;
  /** Local development and tests only: allow http and private hosts. */
  allowPrivateTargets?: boolean;
  retryDelaysMs?: number[];
}

export class AuditWebhook {
  private readonly opts: AuditWebhookOptions;
  private readonly doFetch: typeof fetch;
  private current: AuditWebhookSettings | undefined;
  private queue: AuditCopy[] = [];
  private running: Promise<void> | undefined;
  /** The last policy decision per conversation and tool, waiting for its tool_call entry. */
  private readonly decisions = new Map<string, AuditDecision>();

  constructor(opts: AuditWebhookOptions) {
    this.opts = opts;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.current = readSettings(opts.state);
  }

  settings(): AuditWebhookSettings | undefined {
    return this.current;
  }

  /** Point the copies at `url`. The secret is stored next to the other secrets, mode 0600. */
  async connect(url: string, secret: string): Promise<{ ok: true; host: string } | { ok: false; reason: string }> {
    let target: URL;
    try {
      target = new URL(url.trim());
    } catch {
      return { ok: false, reason: "that is not a URL" };
    }
    if (!this.opts.allowPrivateTargets) {
      if (target.protocol !== "https:") return { ok: false, reason: "the URL must start with https://" };
      const check = await checkPublicTarget(target, this.opts.lookup);
      if (!check.ok) return { ok: false, reason: check.reason };
    }
    if (secret.trim().length < 16) return { ok: false, reason: "the secret must be at least 16 characters" };
    const settings: AuditWebhookSettings = { url: target.toString(), secret: secret.trim(), connectedAt: new Date().toISOString() };
    const file = this.opts.state.path(AUDIT_WEBHOOK_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
    this.current = settings;
    return { ok: true, host: target.host };
  }

  /** Stop sending. Copies already queued are delivered first. */
  async disconnect(): Promise<boolean> {
    if (!this.current) return false;
    await this.idle();
    this.current = undefined;
    this.queue = [];
    fs.rmSync(this.opts.state.path(AUDIT_WEBHOOK_FILE), { force: true });
    fs.rmSync(this.opts.state.path(AUDIT_WEBHOOK_OUTBOX), { force: true });
    return true;
  }

  /** Listen to an audit log. Returns the unsubscribe function. */
  attach(audit: AuditLog): () => void {
    return audit.subscribe((entry) => this.hear(entry));
  }

  hear(entry: AuditEntry): void {
    if (!this.current) return;
    const copy = this.copyOf(entry);
    if (!copy) return;
    this.queue.push(copy);
    this.pump();
  }

  /** Resolves when every queued copy was delivered or parked. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** The copy the receiver gets, or undefined when there is nothing to send. Public for tests. */
  copyOf(entry: AuditEntry): AuditCopy | undefined {
    const tool = typeof entry.detail.tool === "string" ? entry.detail.tool : undefined;
    const key = `${entry.conversationKey ?? ""}|${tool ?? ""}`;
    if (entry.kind === "policy" && tool && typeof entry.detail.outcome === "string") {
      if (this.decisions.size > 500) this.decisions.clear(); // asks that never ran: do not grow forever
      const reason = typeof entry.detail.reason === "string" ? entry.detail.reason : "";
      this.decisions.set(key, {
        outcome: entry.detail.outcome,
        ...(entry.detail.outcome === "allow" && reason.startsWith("owner approved") ? { approved: true } : {}),
        ...(typeof entry.detail.viaGrant === "string" ? { viaGrant: entry.detail.viaGrant } : {}),
      });
    }
    let decision: AuditDecision | undefined;
    if (entry.kind === "tool_call" && tool) {
      decision = this.decisions.get(key);
      this.decisions.delete(key);
    }
    const principal = entry.principal;
    const tier = principal ? (principal === "owner" ? "owner" : this.opts.tierOf?.(principal)) : undefined;
    return {
      id: createHash("sha256").update(JSON.stringify(entry)).digest("hex").slice(0, 24),
      source: "open-instinct",
      agent: this.opts.agent,
      ...(this.opts.model ? { model: this.opts.model } : {}),
      entry: {
        at: entry.at,
        kind: entry.kind,
        ...(principal ? { principal: principal.split(":")[0] } : {}),
        ...(tier ? { tier } : {}),
        ...(entry.conversationKey ? { conversation: createHash("sha256").update(entry.conversationKey).digest("hex").slice(0, 16) } : {}),
        detail: factsOf(entry.detail),
        ...(decision ? { decision } : {}),
      },
    };
  }

  private pump(): void {
    if (this.running) return;
    this.running = this.drain().finally(() => {
      this.running = undefined;
      if (this.queue.length > 0 && this.current) this.pump();
    });
  }

  private async drain(): Promise<void> {
    // Copies that failed earlier go out first, so the receiver sees entries in order.
    this.queue.unshift(...this.takeOutbox());
    while (this.queue.length > 0) {
      const settings = this.current;
      if (!settings) {
        this.queue = [];
        return;
      }
      if (!(await this.deliverWithRetry(settings, this.queue[0]!))) {
        this.park(this.queue);
        this.queue = [];
        return;
      }
      this.queue.shift();
    }
  }

  private async deliverWithRetry(settings: AuditWebhookSettings, copy: AuditCopy): Promise<boolean> {
    const delays = this.opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      if (await this.deliver(settings, copy)) return true;
      if (attempt >= delays.length) return false;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }

  /** True when the copy is done with: delivered, or refused for good. */
  private async deliver(settings: AuditWebhookSettings, copy: AuditCopy): Promise<boolean> {
    const body = JSON.stringify(copy);
    const signature = `sha256=${createHmac("sha256", settings.secret).update(body).digest("hex")}`;
    try {
      const res = await this.doFetch(settings.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "open-instinct/0.1 audit-webhook",
          [AUDIT_SIGNATURE_HEADER]: signature,
          "X-Instinct-Event": copy.entry.kind,
          "X-Instinct-Delivery": copy.id,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return true;
      // A refusal (bad signature, unknown agent) will not get better by retrying: drop it and go on.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        this.opts.logger?.(`audit webhook: ${new URL(settings.url).host} refused a copy (HTTP ${res.status})`);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private takeOutbox(): AuditCopy[] {
    const lines = this.opts.state.readLines(AUDIT_WEBHOOK_OUTBOX);
    if (lines.length === 0) return [];
    fs.rmSync(this.opts.state.path(AUDIT_WEBHOOK_OUTBOX), { force: true });
    const copies: AuditCopy[] = [];
    for (const line of lines) {
      try {
        copies.push(JSON.parse(line) as AuditCopy);
      } catch {
        // A torn line from a crash mid-write: skip it.
      }
    }
    return copies;
  }

  private park(copies: AuditCopy[]): void {
    const kept = copies.slice(-OUTBOX_CAP);
    this.opts.state.writeText(AUDIT_WEBHOOK_OUTBOX, kept.map((c) => JSON.stringify(c)).join("\n") + "\n");
    this.opts.logger?.(`audit webhook: receiver unreachable, ${kept.length} copies waiting`);
  }
}

function readSettings(state: StateDir): AuditWebhookSettings | undefined {
  const s = state.readJson<Partial<AuditWebhookSettings> | undefined>(AUDIT_WEBHOOK_FILE, undefined);
  return s && typeof s.url === "string" && typeof s.secret === "string" ? { url: s.url, secret: s.secret, connectedAt: s.connectedAt ?? "" } : undefined;
}

function factsOf(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (DROPPED_KEYS.has(k)) continue;
    out[k] = typeof v === "string" && v.length > 300 ? `${v.slice(0, 299)}…` : v;
  }
  return out;
}

/**
 * The owner connects or disconnects the webhook in chat ("send my audit log to <url>"). Only on
 * the owner's own direct message: a web page, an email or another agent cannot point the copies
 * somewhere else.
 */
export function auditWebhookTool(webhook: AuditWebhook, audit: AuditLog): RegisteredTool {
  return defineTool({
    name: "audit_webhook",
    label: "Audit webhook",
    description:
      "Send a signed copy of every audit entry (tool calls, policy decisions, approvals, spend; never message or file contents) " +
      "to one https URL the owner chose, such as a monitoring service or an insurer. action: connect (needs url and secret), " +
      "disconnect, or status. Owner only, and only for a URL and secret the owner gave you or a service the owner asked you to connect.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("connect"), Type.Literal("disconnect"), Type.Literal("status")]),
      url: Type.Optional(Type.String({ description: "https URL that receives the copies" })),
      secret: Type.Optional(Type.String({ description: "Shared signing secret from the receiving service, at least 16 characters" })),
    }),
    meta: {
      capabilities: ["trust.manage"],
      group: "owner",
      describe: (a) => {
        const args = (a ?? {}) as { action?: string; url?: string };
        return `audit_webhook ${args.action ?? ""}${args.url ? ` ${hostOf(args.url)}` : ""}`.trim();
      },
    },
    execute: async ({ action, url, secret }, ctx) => {
      if (action === "status") {
        const s = webhook.settings();
        return textResult(s ? `Audit copies go to ${hostOf(s.url)} since ${s.connectedAt}.` : "No audit webhook is connected.");
      }
      if (ctx.ownerTurn !== true) {
        return { content: [{ type: "text", text: "Only the owner, in their own message, can change where audit copies go." }], isError: true };
      }
      if (action === "disconnect") {
        const host = webhook.settings() ? hostOf(webhook.settings()!.url) : "";
        if (!host) return textResult("No audit webhook was connected.");
        audit.append({ kind: "policy", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { action: "audit_webhook", disconnected: host } });
        await webhook.disconnect();
        return textResult(`Stopped sending audit copies to ${host}.`);
      }
      if (!url || !secret) return { content: [{ type: "text", text: "connect needs both url and secret." }], isError: true };
      const result = await webhook.connect(url, secret);
      if (!result.ok) return { content: [{ type: "text", text: `Cannot connect the audit webhook: ${result.reason}.` }], isError: true };
      audit.append({ kind: "policy", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { action: "audit_webhook", connected: result.host } });
      return textResult(`Connected. From now on a signed copy of every audit entry goes to ${result.host}. Tell the owner.`);
    },
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

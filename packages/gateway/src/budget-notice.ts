/**
 * Tell an owner their agent is paused when Maritime refuses a text because the agent's
 * AI budget is spent. The agent itself cannot say so: it is asleep and Maritime will not
 * wake it. The gateway keeps the owner's text queued and retries it, so it reaches the
 * agent once the budget is raised; this notice only explains the silence meanwhile.
 */
import { Inkbox } from "@inkbox/sdk";
import { type Logger, silentLogger } from "./logger.js";
import { conversationIdOf } from "./relay.js";
import type { UserRecord } from "./store.js";

export const DEFAULT_BUDGET_NOTICE_COOLDOWN_MS = 6 * 60 * 60_000;

export type BudgetNoticeSend = (user: UserRecord, event: Record<string, unknown>, text: string) => Promise<void>;

export interface BudgetNoticeOptions {
  /** What the owner reads, for example core's `budgetExhaustedReply(contact)`. */
  text: string;
  /** Inkbox API base URL when not the default. */
  inkboxBaseUrl?: string;
  /** One notice per owner in this window, however many texts arrive. Default six hours. */
  cooldownMs?: number;
  now?: () => number;
  logger?: Logger;
  /** Replaces the Inkbox send. Tests use it; the default answers in the inbound iMessage conversation as the agent. */
  send?: BudgetNoticeSend;
}

/** The phone the text came from, when the event is a 1:1 iMessage or SMS. */
function senderOf(event: Record<string, unknown>): string | undefined {
  const data = (event["data"] ?? {}) as Record<string, unknown>;
  const message = (data["message"] ?? data) as Record<string, unknown>;
  if (message["is_group"] === true) return undefined;
  const raw = message["remote_number"] ?? message["from"] ?? data["from"];
  return typeof raw === "string" && raw && !raw.includes("@") ? raw : undefined;
}

function inkboxSend(baseUrl?: string): BudgetNoticeSend {
  return async (user, event, text) => {
    const eventType = String(event["event_type"] ?? "");
    if (eventType !== "imessage.received") throw new Error(`no notice path for ${eventType || "an unknown event"}`);
    const sdkOpts: ConstructorParameters<typeof Inkbox>[0] = { apiKey: user.identityApiKey };
    if (baseUrl) sdkOpts.baseUrl = baseUrl;
    const identity = await new Inkbox(sdkOpts).getIdentity(user.handle);
    const conversationId = conversationIdOf(event);
    const to = senderOf(event);
    if (conversationId.startsWith("inkbox:")) {
      if (!to) throw new Error("the event names no conversation and no sender");
      await identity.sendIMessage({ to, text });
      return;
    }
    await identity.sendIMessage({ conversationId, text });
  };
}

/**
 * Builds the gateway's `onBudgetExhausted` handler. Only owner texts (1:1 iMessage or SMS
 * received) get a notice; agent-to-agent and system events are left alone.
 */
export function createBudgetNotifier(opts: BudgetNoticeOptions): (user: UserRecord, event: Record<string, unknown>, reason: string) => Promise<void> {
  const log = opts.logger ?? silentLogger;
  const now = opts.now ?? Date.now;
  const cooldown = opts.cooldownMs ?? DEFAULT_BUDGET_NOTICE_COOLDOWN_MS;
  const send = opts.send ?? inkboxSend(opts.inkboxBaseUrl);
  const lastNotice = new Map<string, number>();
  return async (user, event, reason) => {
    const eventType = String(event["event_type"] ?? "");
    if (!/^(imessage|sms)\.received$/.test(eventType) || !senderOf(event)) return;
    const at = lastNotice.get(user.id);
    if (at !== undefined && now() - at < cooldown) return;
    lastNotice.set(user.id, now());
    try {
      await send(user, event, opts.text);
      log.info("budget_notice.sent", { userId: user.id, handle: user.handle, reason: reason.slice(0, 160) });
    } catch (err) {
      lastNotice.delete(user.id);
      log.warn("budget_notice.failed", { userId: user.id, handle: user.handle, error: err instanceof Error ? err.message : String(err) });
    }
  };
}

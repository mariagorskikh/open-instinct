/**
 * Turn an Inkbox webhook envelope into the one InboundMessage shape the runtime
 * understands. Delivery lifecycle events (sent, delivered, bounced, failed) return
 * undefined: nothing to say to the model. A2A events all carry something to hear,
 * including progress on tasks we sent and a caller cancelling one of ours. Every
 * field is read defensively; the wire shape has moved between SDK versions and
 * will move again.
 */
import { normalizePhone } from "@open-instinct/core";
import type { InboundMessage } from "@open-instinct/core";

type Dict = Record<string, unknown>;

function dict(v: unknown): Dict | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function strings(v: unknown): string[] {
  return list(v).filter((x): x is string => typeof x === "string");
}

function receivedAt(payload: Dict): string {
  return str(payload.timestamp) ?? new Date().toISOString();
}

function eventId(payload: Dict, fallback: string): string {
  return str(payload.id) ?? fallback;
}

function attachmentsFromMedia(media: unknown): InboundMessage["attachments"] {
  const out: NonNullable<InboundMessage["attachments"]> = [];
  for (const item of list(media)) {
    const m = dict(item);
    if (!m) continue;
    const url = str(m.url);
    if (!url) continue;
    const a: NonNullable<InboundMessage["attachments"]>[number] = { url };
    const mime = str(m.content_type) ?? str(m.mime_type);
    if (mime) a.mimeType = mime;
    const name = str(m.filename) ?? str(m.name);
    if (name) a.name = name;
    out.push(a);
  }
  return out;
}

function contactsMeta(data: Dict): Dict {
  const meta: Dict = {};
  if (Array.isArray(data.contacts)) meta.contacts = data.contacts;
  if (Array.isArray(data.agent_identities)) meta.agentIdentities = data.agent_identities;
  return meta;
}

function parseIMessageReceived(payload: Dict, data: Dict): InboundMessage | undefined {
  const message = dict(data.message);
  if (!message) return undefined;
  const conversationId = str(message.conversation_id);
  if (!conversationId) return undefined;
  const isGroup = message.is_group === true;
  const from = (isGroup ? str(message.sender_number) : undefined) ?? str(message.remote_number) ?? str(message.sender_number) ?? "";
  const text = str(message.content) ?? "";
  const attachments = attachmentsFromMedia(message.media);
  const msg: InboundMessage = {
    id: eventId(payload, `imessage:${str(message.id) ?? conversationId}`),
    channel: "imessage",
    conversationKey: `imessage:${conversationId}`,
    from,
    text: text || (attachments && attachments.length > 0 ? "[attachment]" : ""),
    replyRef: {
      conversationId,
      messageId: str(message.id),
      assignmentId: str(message.assignment_id),
      replyToMessageId: str(message.reply_to_message_id),
    },
    receivedAt: receivedAt(payload),
    source: "webhook",
    meta: {
      ...contactsMeta(data),
      isGroup,
      conversationScopeKnown: typeof message.is_group === "boolean",
      participants: strings(message.participants),
      service: str(message.service),
    },
  };
  if (attachments && attachments.length > 0) msg.attachments = attachments;
  return msg;
}

function parseIMessageReaction(payload: Dict, data: Dict): InboundMessage | undefined {
  const reaction = dict(data.reaction);
  if (!reaction) return undefined;
  const conversationId = str(reaction.conversation_id);
  if (!conversationId) return undefined;
  const type = str(reaction.reaction) ?? "reaction";
  const emoji = str(reaction.custom_emoji);
  const label = type === "custom" && emoji ? emoji : type;
  const target = str(reaction.target_message_id) ?? "unknown";
  return {
    id: eventId(payload, `reaction:${str(reaction.id) ?? target}`),
    channel: "imessage",
    conversationKey: `imessage:${conversationId}`,
    from: str(reaction.remote_number) ?? "",
    text: `[reaction ${label} on message ${target}]`,
    replyRef: { conversationId, messageId: target, assignmentId: str(reaction.assignment_id) },
    receivedAt: receivedAt(payload),
    source: "webhook",
    meta: {
      ...contactsMeta(data),
      // Reactions omit the conversation's membership; resolve it before admission.
      conversationScopeKnown: false,
      reaction: { type, customEmoji: emoji, targetMessageId: target, reactionId: str(reaction.id) },
    },
  };
}

function parseTextReceived(payload: Dict, data: Dict): InboundMessage | undefined {
  // The SDK types say `text_message`; older docs say `message`. Accept both.
  const message = dict(data.text_message) ?? dict(data.message);
  if (!message) return undefined;
  const rawFrom = str(message.sender_phone_number) ?? str(message.remote_phone_number) ?? str(message.remote_number) ?? str(message.from);
  if (!rawFrom) return undefined;
  const from = normalizePhone(rawFrom) || rawFrom;
  const text = str(message.text) ?? str(message.content) ?? str(message.body) ?? "";
  const attachments = attachmentsFromMedia(message.media);
  const conversationId = str(message.conversation_id) ?? str(message.conversation_key);
  const msg: InboundMessage = {
    id: eventId(payload, `sms:${str(message.id) ?? from}`),
    channel: "sms",
    conversationKey: `sms:${conversationId ?? from}`,
    from,
    text: text || (attachments && attachments.length > 0 ? "[attachment]" : ""),
    replyRef: {
      textId: str(message.id),
      conversationId,
      localNumber: str(message.local_phone_number),
    },
    receivedAt: receivedAt(payload),
    source: "webhook",
    meta: { ...contactsMeta(data), type: str(message.type), conversationScopeKnown: false },
  };
  if (attachments && attachments.length > 0) msg.attachments = attachments;
  return msg;
}

function parseMailReceived(payload: Dict, data: Dict): InboundMessage | undefined {
  const message = dict(data.message);
  if (!message) return undefined;
  const from = str(message.from_address);
  if (!from) return undefined;
  const subject = str(message.subject) ?? "(no subject)";
  const body = str(message.body) ?? str(message.snippet) ?? "";
  const threadId = str(message.thread_id) ?? str(message.id) ?? "unknown";
  return {
    id: eventId(payload, `email:${str(message.id) ?? threadId}`),
    channel: "email",
    conversationKey: `email:${threadId}`,
    from: from.toLowerCase(),
    text: `Subject: ${subject}\n\n${body}`,
    replyRef: {
      // The sender is the reply recipient; the channel reads it when the outbound has no `to`.
      from: from.toLowerCase(),
      // The RFC 5322 Message-ID threads replies; the Inkbox id fetches the full body.
      messageId: str(message.message_id) ?? str(message.id),
      inkboxMessageId: str(message.id),
      threadId,
      subject,
      mailbox: str(message.email_address),
    },
    receivedAt: receivedAt(payload),
    source: "webhook",
    meta: {
      ...contactsMeta(data),
      to: strings(message.to_addresses),
      cc: strings(message.cc_addresses),
      hasAttachments: message.has_attachments === true,
      bodyTruncated: message.body_truncated === true || message.body_state === "truncated",
      bodyUnavailable: !str(message.body) || message.body_state === "unavailable",
    },
  };
}

/** Which side of an A2A task an event describes. */
type A2ADirection = "received" | "sent";

/**
 * The counterpart on an A2A event. On tasks we received, `caller` is the peer. On
 * `a2a.sent_task.updated`, `caller` is our own identity and the peer rides on
 * `sender` (the SDK shape) or, on other servers, `worker`, `callee` or `identity`.
 */
function a2aPeer(data: Dict, direction: A2ADirection): Dict {
  if (direction === "received") return dict(data.caller) ?? dict(data.sender) ?? {};
  return dict(data.sender) ?? dict(data.worker) ?? dict(data.callee) ?? dict(data.identity) ?? {};
}

function a2aParts(data: Dict): { texts: string[]; firstData?: Record<string, unknown> } {
  const texts: string[] = [];
  let firstData: Record<string, unknown> | undefined;
  for (const part of list(data.parts)) {
    const p = dict(part);
    if (!p) continue;
    const t = str(p.text);
    if (t) texts.push(t);
    const d = dict(p.data);
    if (d && !firstData) firstData = d;
  }
  return firstData ? { texts, firstData } : { texts };
}

function parseA2ATask(payload: Dict, data: Dict, eventType: string, direction: A2ADirection): InboundMessage | undefined {
  const taskId = str(data.task_id);
  const contextId = str(data.context_id) ?? taskId;
  if (!taskId || !contextId) return undefined;
  const peer = a2aPeer(data, direction);
  const handle = str(peer.handle) ?? "";
  const state = str(data.state);
  const { texts, firstData } = a2aParts(data);
  // Progress on a sent task may carry only a state change; still prompt so the model can report it.
  const text = texts.length > 0 ? texts.join("\n\n") : direction === "sent" && state ? `[${state}]` : "";
  const messageId = str(data.message_id);
  const msg: InboundMessage = {
    // Successive state updates arrive without a message id; keep them apart so dedupe does not eat them.
    id: eventId(payload, `a2a:${taskId}:${messageId ?? state ?? eventType}`),
    channel: "a2a",
    conversationKey: `a2a:${contextId}`,
    from: handle,
    text,
    ...(firstData ? { data: firstData } : {}),
    replyRef: { taskId, contextId, messageId },
    receivedAt: receivedAt(payload),
    source: "webhook",
    meta: {
      eventType,
      state,
      direction,
      callerIdentityId: str(peer.identity_id),
      callerOrganizationId: str(peer.organization_id),
    },
  };
  if (firstData) msg.data = firstData;
  return msg;
}

/** The caller withdrew a task we were working on. A short system-style line tells the model to stop. */
function parseA2ATaskCanceled(payload: Dict, data: Dict, eventType: string): InboundMessage | undefined {
  const base = parseA2ATask(payload, data, eventType, "received");
  if (!base) return undefined;
  const taskId = base.replyRef.taskId ?? "";
  const by = base.from ? ` by @${base.from}` : " by the caller";
  const note = base.text ? `\n\n${base.text}` : "";
  return {
    ...base,
    id: eventId(payload, `a2a:${taskId}:canceled`),
    text: `[task ${taskId} canceled${by}]${note}`,
    meta: { ...base.meta, state: str(data.state) ?? "canceled" },
  };
}

/** A finished phone call, as `call.ended` describes it. Not an InboundMessage: the model never sees it. */
export interface CallEndedEvent {
  /** Stable event id, the dedupe key across redeliveries. */
  id: string;
  callId: string;
  remoteNumber: string;
  /** Address-book name Inkbox matched for the remote number, when any. */
  contactName?: string;
  direction: string;
  /** initiated, ringing, answered, completed, failed or canceled. */
  status: string;
  /** Voice AI's verdict: completed, no_answer, declined or failed. Absent on client-driven calls. */
  outcome?: string;
  /** local, remote, max_duration, voicemail or rejected. */
  hangupReason?: string;
  durationSeconds?: number;
  /** The task brief the call was placed with. */
  reason?: string;
  /**
   * The inline transcript. `null` means Inkbox captured none inline and the verbatim one
   * must be fetched; an array may be abridged (the middle cut) and is used as is.
   */
  transcript: Array<{ party: string; text: string }> | null;
  transcriptAbridged: boolean;
  actionItems: Array<{ action: string; details?: string }>;
  receivedAt: string;
}

/** `call.ended` only. Anything else, or a payload without a call, is undefined. */
export function parseCallEnded(payload: unknown): CallEndedEvent | undefined {
  const p = dict(payload);
  if (!p || str(p.event_type) !== "call.ended") return undefined;
  const data = dict(p.data);
  const call = data ? dict(data.call) : undefined;
  if (!data || !call) return undefined;
  const callId = str(call.id);
  if (!callId) return undefined;
  const transcriptBlock = dict(data.transcript);
  let transcript: CallEndedEvent["transcript"] = null;
  if (transcriptBlock) {
    transcript = [];
    for (const entry of list(transcriptBlock.entries)) {
      const e = dict(entry);
      if (!e || e.marker) continue;
      const text = str(e.text)?.trim();
      if (!text) continue;
      transcript.push({ party: str(e.party) ?? "remote", text });
    }
  }
  const actionItems: CallEndedEvent["actionItems"] = [];
  for (const raw of list(data.post_call_action_items)) {
    const item = dict(raw);
    const action = item ? str(item.action) : undefined;
    if (!action) continue;
    const details = item ? str(item.details) : undefined;
    actionItems.push(details ? { action, details } : { action });
  }
  const contactName = list(data.contacts)
    .map((c) => dict(c))
    .map((c) => (c ? str(c.name) ?? str(c.display_name) : undefined))
    .find((n): n is string => Boolean(n));
  const out: CallEndedEvent = {
    id: eventId(p, `call:${callId}:ended`),
    callId,
    remoteNumber: str(call.remote_phone_number) ?? str(call.remote_number) ?? "",
    direction: str(call.direction) ?? "outbound",
    status: str(call.status) ?? "completed",
    transcript,
    transcriptAbridged: transcriptBlock?.abridged === true,
    actionItems,
    receivedAt: receivedAt(p),
  };
  if (contactName) out.contactName = contactName;
  const outcome = str(data.outcome);
  if (outcome) out.outcome = outcome;
  const hangup = str(call.hangup_reason);
  if (hangup) out.hangupReason = hangup;
  if (typeof call.duration_seconds === "number") out.durationSeconds = call.duration_seconds;
  const reason = str(call.reason);
  if (reason) out.reason = reason;
  return out;
}

/** Events that carry something the model should hear. */
export const INBOUND_EVENT_TYPES = [
  "imessage.received",
  "imessage.reaction_received",
  "text.received",
  "message.received",
  "a2a.task.created",
  "a2a.task.message",
  "a2a.task.canceled",
  "a2a.sent_task.updated",
] as const;

export function parseInkboxEvent(payload: unknown): InboundMessage | undefined {
  const p = dict(payload);
  if (!p) return undefined;
  const eventType = str(p.event_type);
  const data = dict(p.data);
  if (!eventType || !data) return undefined;
  switch (eventType) {
    case "imessage.received":
      return parseIMessageReceived(p, data);
    case "imessage.reaction_received":
      return parseIMessageReaction(p, data);
    case "text.received":
      return parseTextReceived(p, data);
    case "message.received":
      return parseMailReceived(p, data);
    case "a2a.task.created":
    case "a2a.task.message":
      return parseA2ATask(p, data, eventType, "received");
    case "a2a.task.canceled":
      return parseA2ATaskCanceled(p, data, eventType);
    case "a2a.sent_task.updated":
      // The peer's progress or answer on a task we sent with ask_instinct.
      return parseA2ATask(p, data, eventType, "sent");
    default:
      // sent, delivered, bounced, failed, read: nothing to prompt with. call.ended is
      // reported to the owner from its transcript (parseCallEnded), not through the model.
      return undefined;
  }
}

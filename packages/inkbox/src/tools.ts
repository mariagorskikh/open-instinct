/**
 * Messaging tools the model can call. The policy guard decides whether the
 * principal may converse at all; this file enforces the one rule policy cannot
 * express: a non-owner may only speak in their own thread or to the owner.
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { defineTool, normalizeHandle, normalizePhone, textResult } from "@open-instinct/core";
import type { Contact, ContactStore, InstinctConfig, OutboundMessage, RegisteredTool, ToolContext, ToolResultLike } from "@open-instinct/core";
import type { CallOrigination, FileSend, InkboxChannel } from "./channel.js";
import { CALL_ORIGINATIONS, parseConversationKey } from "./channel.js";

/**
 * What send_file needs. The channel is optional: without Inkbox the tool still
 * hands files to the dashboard chat, and refuses iMessage, SMS and email.
 */
export interface SendFileDeps {
  channel?: InkboxChannel;
  contacts: ContactStore;
  config: InstinctConfig;
  /**
   * The state directory (`/data` on Maritime). send_file reads workspace-relative paths
   * under `<dataDir>/workspace` and absolute paths anywhere under `dataDir`. Without it
   * send_file refuses every path.
   */
  dataDir?: string;
}

export interface MessagingDeps extends SendFileDeps {
  channel: InkboxChannel;
  /**
   * Where a reply goes when the current conversation cannot carry one (the dashboard chat
   * has no outbound side). The runtime stashes it for the owner's next turn. Omitted: the
   * tool reports that it cannot reply there.
   */
  sendToOwner?: (text: string, ctx: { conversationKey: string }) => Promise<unknown>;
  /** Force where calls go out from (INKBOX_CALL_ORIGINATION). Omitted: the identity's iMessage line. */
  callOrigination?: CallOrigination;
}

/** What phone_call needs: a channel that can place calls, and optionally a fixed origination. */
export interface PhoneCallDeps {
  channel: Pick<InkboxChannel, "placeCall">;
  callOrigination?: CallOrigination;
}

type SendChannel = "imessage" | "sms" | "email";

export interface ResolvedTarget {
  channel: SendChannel;
  to: string;
  label: string;
}

function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function looksLikePhone(s: string): boolean {
  return /^\+?[\d\s().-]{7,}$/.test(s) && s.replace(/\D/g, "").length >= 7;
}

function pickForContact(c: Contact, preferred?: SendChannel): ResolvedTarget {
  const phone = c.phones[0];
  const email = c.emails[0];
  if (preferred === "email" || (!preferred && !phone)) {
    if (!email) throw new Error(`${c.name} has no email on file`);
    return { channel: "email", to: email, label: c.name };
  }
  if (!phone) throw new Error(`${c.name} has no phone number on file`);
  return { channel: preferred === "sms" ? "sms" : "imessage", to: phone, label: c.name };
}

/**
 * "owner", a contact id or name, a phone number or an email address become a
 * concrete channel and address. iMessage is the default for phone numbers.
 */
export function resolveTarget(to: string, deps: Pick<MessagingDeps, "contacts" | "config">, preferred?: SendChannel): ResolvedTarget {
  const raw = to.trim();
  if (!raw) throw new Error("`to` is empty");
  if (raw.toLowerCase() === "owner") {
    const owner = deps.config.owner;
    const phone = owner.phones[0];
    const email = owner.emails[0];
    if (preferred === "email" || (!preferred && !phone)) {
      if (!email) throw new Error("the owner has no email configured");
      return { channel: "email", to: email, label: owner.name };
    }
    if (!phone) throw new Error("the owner has no phone configured");
    return { channel: preferred === "sms" ? "sms" : "imessage", to: phone, label: owner.name };
  }
  if (looksLikeEmail(raw)) {
    const c = deps.contacts.findByEmail(raw);
    return { channel: "email", to: raw.toLowerCase(), label: c?.name ?? raw };
  }
  if (looksLikePhone(raw)) {
    const phone = normalizePhone(raw);
    const c = deps.contacts.findByPhone(phone);
    return { channel: preferred === "sms" ? "sms" : "imessage", to: phone, label: c?.name ?? phone };
  }
  const byId = deps.contacts.get(raw) ?? deps.contacts.get(normalizeHandle(raw).replace(/\s+/g, "-"));
  if (byId) return pickForContact(byId, preferred);
  const matches = deps.contacts.search(raw);
  if (matches.length === 1 && matches[0]) return pickForContact(matches[0], preferred);
  if (matches.length > 1) {
    throw new Error(`"${raw}" matches several contacts: ${matches.map((m) => m.id).join(", ")}. Use the contact id.`);
  }
  throw new Error(`no contact, phone or email matches "${raw}"`);
}

export interface ResolvedFile {
  /** Canonical absolute path. */
  path: string;
  name: string;
  size: number;
  mime: string;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  ics: "text/calendar",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeTypeFor(filename: string): string {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Turn a tool path into a readable file inside the data directory. Relative paths
 * are workspace-relative; absolute paths must stay under the data directory after
 * symlinks are followed. Throws with a plain reason otherwise.
 */
export function resolveFilePath(dataDir: string, requested: string): ResolvedFile {
  const raw = requested.trim();
  if (!raw || raw.includes("\0")) throw new Error("`path` is empty");
  const root = realpathOr(path.resolve(dataDir));
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, "workspace", raw);
  if (!fs.existsSync(candidate)) throw new Error(`no file at ${raw}`);
  const real = realpathOr(candidate);
  if (!real.startsWith(root + path.sep)) throw new Error(`Refused: "${raw}" is outside the data directory`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`${raw} is not a file`);
  return { path: real, name: path.basename(real), size: stat.size, mime: mimeTypeFor(real) };
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** The fence Maritime's `maritime-share` prints; the dashboard renders it as an attachment. */
export function maritimeFileFence(file: ResolvedFile, extra: { title?: string; message?: string } = {}): string {
  const payload: Record<string, string | number> = { path: file.path, name: file.name, size: file.size, mime: file.mime };
  if (extra.title) payload.title = extra.title;
  if (extra.message) payload.message = extra.message;
  return "```maritime-file\n" + JSON.stringify(payload) + "\n```";
}

const sendFileParams = Type.Object({
  path: Type.String({ description: "The file: a workspace-relative path (research/brief.pdf) or an absolute path under the data directory." }),
  to: Type.Optional(
    Type.String({
      description: 'Recipient: a contact id or name, a phone number, an email address, or "owner". Omit to send in the current conversation.',
    }),
  ),
  channel: Type.Optional(
    Type.Union([Type.Literal("imessage"), Type.Literal("sms"), Type.Literal("email")], {
      description: "Force a channel. Default: iMessage for phones, email for addresses. Email for anything over a few MB or a few pages.",
    }),
  ),
  caption: Type.Optional(Type.String({ description: "One line sent with the file (the iMessage bubble or the email body)." })),
  subject: Type.Optional(Type.String({ description: "Email subject when starting a new email thread." })),
});

function fail(text: string): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true };
}

function isOwner(ctx: ToolContext): boolean {
  return ctx.principal.kind === "owner";
}

const sendMessageParams = Type.Object({
  to: Type.Optional(
    Type.String({
      description: 'Recipient: a contact id or name, a phone number, an email address, or "owner". Omit to reply in the current conversation.',
    }),
  ),
  channel: Type.Optional(
    Type.Union([Type.Literal("imessage"), Type.Literal("sms"), Type.Literal("email")], {
      description: "Force a channel. Default: iMessage for phones, email for addresses.",
    }),
  ),
  text: Type.String({ description: "The message. Plain text; keep iMessage short." }),
  subject: Type.Optional(Type.String({ description: "Email subject when starting a new email thread." })),
});

const reactParams = Type.Object({
  messageId: Type.String({ description: "The iMessage id to react to (from the conversation)." }),
  reaction: Type.String({ description: "love, like, dislike, laugh, emphasize or question." }),
});

export function messagingTools(deps: MessagingDeps): RegisteredTool[] {
  const sendMessage = defineTool({
    name: "send_message",
    label: "Send message",
    description:
      "Send a text message. With no `to`, replies in the current conversation. With `to`, messages a contact, a phone number, an email address, or the owner.",
    parameters: sendMessageParams,
    meta: {
      capabilities: ["converse"],
      group: "messaging",
      describe: (args) => {
        const a = args as { to?: string; text?: string };
        return `send_message to ${a.to ?? "current conversation"}: ${(a.text ?? "").slice(0, 80)}`;
      },
    },
    execute: async (args, ctx) => {
      const text = args.text.trim();
      if (!text) return { content: [{ type: "text", text: "Nothing to send: text is empty." }], isError: true };

      if (!args.to) {
        const deliveryKey = ctx.deliveryKey ?? ctx.conversationKey;
        const key = parseConversationKey(deliveryKey);
        if (key.channel === "a2a") {
          throw new Error("This is an agent-to-agent conversation. Use reply_instinct to answer the other agent.");
        }
        if (key.channel === "chat" && ctx.principal.kind === "owner" && deps.sendToOwner) {
          await deps.sendToOwner(text, { conversationKey: ctx.conversationKey });
          return textResult("Queued for the owner; it shows in their chat with your next reply.");
        }
        if (key.channel !== "imessage" && key.channel !== "sms" && key.channel !== "email") {
          throw new Error(`Cannot reply on "${ctx.conversationKey}". Give \`to\` to pick a recipient.`);
        }
        const msg: OutboundMessage = { channel: key.channel, conversationKey: deliveryKey, text, ...(ctx.replyRef ? { replyRef: ctx.replyRef } : {}) };
        await deps.channel.send(msg, { principal: ctx.principal, conversationKey: ctx.conversationKey });
        return textResult(`Sent in the current ${key.channel} conversation.`);
      }

      const wantsOwner = args.to.trim().toLowerCase() === "owner";
      if (!isOwner(ctx) && !wantsOwner) {
        throw new Error(`${ctx.principal.displayName} may only reply here or leave a message for the owner (to: "owner").`);
      }

      const target = resolveTarget(args.to, deps, args.channel);
      const msg: OutboundMessage = { channel: target.channel, to: target.to, text };
      if (target.channel === "email") {
        (msg as OutboundMessage & { replyRef?: Record<string, string | undefined> }).replyRef = {
          subject: args.subject ?? (wantsOwner && !isOwner(ctx) ? `Message from ${ctx.principal.displayName}` : "Message from your Instinct"),
        };
      }
      if (!isOwner(ctx) && wantsOwner) {
        // The owner must always know who a relayed message came from.
        msg.text = `From ${readableName(ctx.principal.displayName)}: ${text}`;
      }
      await deps.channel.send(msg, { principal: ctx.principal, conversationKey: ctx.conversationKey });
      return textResult(`Sent to ${target.label} via ${target.channel}.`);
    },
  });

  const sendTyping = defineTool({
    name: "send_typing",
    label: "Show typing",
    description: "Show a typing indicator in the current iMessage conversation while you work. No effect on other channels.",
    parameters: Type.Object({}),
    meta: { capabilities: ["converse"], group: "messaging", describe: () => "send_typing" },
    execute: async (_args, ctx) => {
      await deps.channel.typing(ctx.deliveryKey ?? ctx.conversationKey);
      return textResult("ok");
    },
  });

  const react = defineTool({
    name: "react",
    label: "Tapback",
    description: "Add an iMessage tapback (love, like, dislike, laugh, emphasize, question) to a message in the current conversation.",
    parameters: reactParams,
    meta: {
      capabilities: ["converse"],
      group: "messaging",
      describe: (args) => {
        const a = args as { reaction?: string; messageId?: string };
        return `react ${a.reaction ?? ""} on ${a.messageId ?? ""}`;
      },
    },
    execute: async (args, ctx) => {
      await deps.channel.react(ctx.deliveryKey ?? ctx.conversationKey, args.messageId, args.reaction);
      return textResult(`Reacted ${args.reaction}.`);
    },
  });

  return [sendMessage, sendTyping, react, sendFileTool(deps), phoneCallTool({ channel: deps.channel, ...(deps.callOrigination ? { callOrigination: deps.callOrigination } : {}) })];
}

/** A phone number the carrier will take: `+`, a country code, 7 to 15 digits in all. */
export const E164 = /^\+[1-9]\d{6,14}$/;
export const CALL_REASON_MAX = 2000;
/** Inkbox's cap on the voicemail text. */
export const VOICEMAIL_MESSAGE_MAX = 1000;

const phoneCallParams = Type.Object({
  toNumber: Type.String({ description: "The number to call, in E.164 (+14155550100). Not a contact name: look the number up first and have the owner confirm it." }),
  reason: Type.String({
    description: 'The task brief Inkbox Voice AI follows on the call, in the second person, with every name, time and detail it needs: "Book a table for 4 at 7pm tonight under Maria. If 7 is full, take 7:30. Confirm the time back."',
  }),
  voicemailMessage: Type.Optional(Type.String({ description: "What to say if voicemail answers (under 1000 characters). Omit to let Voice AI compose one from the reason." })),
});

/**
 * Place a call through Inkbox Voice AI. The call is placed and the tool returns; the
 * outcome reaches the owner as a text when the call ends (call.ended webhook), so the
 * model is never the one saying what was agreed on the phone.
 */
export function phoneCallTool(deps: PhoneCallDeps): RegisteredTool {
  if (deps.callOrigination && !CALL_ORIGINATIONS.includes(deps.callOrigination)) {
    throw new Error(`phone_call: unknown call origination "${deps.callOrigination}" (use ${CALL_ORIGINATIONS.join(", ")})`);
  }
  return defineTool({
    name: "phone_call",
    label: "Phone call",
    description:
      "Place a phone call that Inkbox Voice AI makes on the owner's behalf, following `reason` as its brief. Only after the owner has said yes to this exact call: the number and what will be said. Returns the call id and status; the result of the call arrives later as a text to the owner, so do not report an outcome yourself.",
    parameters: phoneCallParams,
    meta: {
      capabilities: ["phone.call"],
      group: "messaging",
      describe: (args) => {
        const a = args as { toNumber?: string; reason?: string };
        return `phone_call ${a.toNumber ?? ""}: ${(a.reason ?? "").slice(0, 80)}`;
      },
    },
    execute: async (args) => {
      const toNumber = normalizePhone(args.toNumber);
      if (!E164.test(toNumber)) return fail(`"${args.toNumber}" is not a phone number in E.164 form (+14155550100).`);
      const reason = args.reason.trim();
      if (!reason) return fail("Nothing to say: `reason` is empty. Give Voice AI the task for the call.");
      if (reason.length > CALL_REASON_MAX) return fail(`The reason is ${reason.length} characters; keep the brief under ${CALL_REASON_MAX}.`);
      const voicemailMessage = args.voicemailMessage?.trim();
      if (voicemailMessage && voicemailMessage.length > VOICEMAIL_MESSAGE_MAX) {
        return fail(`The voicemail message is ${voicemailMessage.length} characters; Inkbox allows ${VOICEMAIL_MESSAGE_MAX}.`);
      }
      const call = await deps.channel.placeCall({
        toNumber,
        reason,
        ...(voicemailMessage ? { voicemailMessage } : {}),
        ...(deps.callOrigination ? { origination: deps.callOrigination } : {}),
      });
      const minutes = call.minutesRemaining !== undefined ? ` ${call.minutesRemaining} call minutes left on the plan this month.` : "";
      return textResult(`Call ${call.id}: ${call.status}.${minutes}`);
    },
  });
}

/**
 * send_file on its own, for an agent without Inkbox: the dashboard chat still gets
 * the file; anything that needs a wire is refused with a plain reason.
 */
export function sendFileTool(deps: SendFileDeps): RegisteredTool {
  const wire = (): InkboxChannel => {
    if (!deps.channel) throw new Error("Inkbox is not configured, so files can only be shared in the dashboard chat here.");
    return deps.channel;
  };
  return defineTool({
    name: "send_file",
    label: "Send file",
    description:
      "Send a file from the workspace as an attachment. With no `to`, sends in the current conversation (iMessage, SMS, email, or the dashboard chat). With `to`, sends to a contact, a phone number, an email address, or the owner. iMessage and SMS take files up to 10 MB; use email for bigger files.",
    parameters: sendFileParams,
    meta: {
      capabilities: ["converse", "files.read"],
      group: "messaging",
      describe: (args) => {
        const a = args as { to?: string; path?: string };
        return `send_file ${a.path ?? ""} to ${a.to ?? "current conversation"}`;
      },
    },
    execute: async (args, ctx) => {
      if (!deps.dataDir) return fail("File sending is not configured (no data directory).");
      let file: ResolvedFile;
      try {
        file = resolveFilePath(deps.dataDir, args.path);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      const caption = args.caption?.trim();
      const content = () => fs.readFileSync(file.path);
      const base = (): Omit<FileSend, "channel"> => ({ filename: file.name, contentType: file.mime, content: content(), ...(caption ? { caption } : {}) });

      if (!args.to) {
        const key = parseConversationKey(ctx.conversationKey);
        if (key.channel === "chat") {
          // The Maritime dashboard turns this fence into an attachment; elsewhere it still names the file.
          const fence = maritimeFileFence(file, { ...(args.subject ? { title: args.subject } : {}), ...(caption ? { message: caption } : {}) });
          return textResult(`${file.path} (${file.size} bytes) is ready. Paste this block verbatim in your reply so the dashboard attaches it:\n${fence}`);
        }
        if (key.channel === "a2a") throw new Error("This is an agent-to-agent conversation; files cannot be attached to it. Give `to` to send it to a person.");
        if (key.channel !== "imessage" && key.channel !== "sms" && key.channel !== "email") {
          throw new Error(`Cannot send a file on "${ctx.conversationKey}". Give \`to\` to pick a recipient.`);
        }
        const send: FileSend = { ...base(), channel: key.channel, conversationKey: ctx.conversationKey };
        if (args.subject) send.subject = args.subject;
        await wire().sendFile(send, { principal: ctx.principal, conversationKey: ctx.conversationKey });
        return textResult(`Sent ${file.name} in the current ${key.channel} conversation.`);
      }

      const wantsOwner = args.to.trim().toLowerCase() === "owner";
      if (!isOwner(ctx) && !wantsOwner) {
        throw new Error(`${ctx.principal.displayName} may only send files here or to the owner (to: "owner").`);
      }
      const target = resolveTarget(args.to, deps, args.channel);
      const send: FileSend = { ...base(), channel: target.channel, to: target.to };
      if (target.channel === "email") send.subject = args.subject ?? (wantsOwner && !isOwner(ctx) ? `File from ${ctx.principal.displayName}` : `${file.name} from your Instinct`);
      if (!isOwner(ctx) && wantsOwner) send.caption = `From ${ctx.principal.displayName}: ${caption ?? file.name}`;
      await wire().sendFile(send, { principal: ctx.principal, conversationKey: ctx.conversationKey });
      return textResult(`Sent ${file.name} to ${target.label} via ${target.channel}.`);
    },
  });
}

/** "grace-liu-wxd83" reads as "Grace Liu"; a real name is left alone. */
export function readableName(name: string): string {
  if (!/^@?[a-z0-9]+(?:-[a-z0-9]+)+$/.test(name)) return name;
  const parts = name.replace(/^@/, "").split("-");
  if (parts.length > 1 && /^[a-z0-9]{4,6}$/.test(parts[parts.length - 1]!) && /\d/.test(parts[parts.length - 1]!)) parts.pop();
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

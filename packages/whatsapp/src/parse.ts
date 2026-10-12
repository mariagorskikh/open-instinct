/**
 * Pure helpers: WhatsApp addresses to E.164 phones and conversation keys, and the text and
 * media inside a message. No socket here, so all of it is unit tested.
 */
import type { proto } from "@whiskeysockets/baileys";

export const CONVERSATION_PREFIX = "whatsapp:";
const PN_SERVER = "@s.whatsapp.net";

/** `447700900123:12@s.whatsapp.net` (device 12) to `+447700900123`. Only phone-number JIDs have a phone. */
export function phoneFromJid(jid: string | null | undefined): string | undefined {
  if (!jid?.endsWith(PN_SERVER)) return undefined;
  const user = jid.slice(0, -PN_SERVER.length).split(":")[0] ?? "";
  return /^\d{6,15}$/.test(user) ? `+${user}` : undefined;
}

export function jidFromPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (!/^\d{6,15}$/.test(digits)) throw new Error(`Not a phone number: ${phone}`);
  return `${digits}${PN_SERVER}`;
}

export function conversationKeyFor(chatJid: string): string {
  return `${CONVERSATION_PREFIX}${chatJid}`;
}

export function jidFromConversationKey(key: string | undefined): string | undefined {
  return key?.startsWith(CONVERSATION_PREFIX) ? key.slice(CONVERSATION_PREFIX.length) : undefined;
}

/** Group, broadcast, status and channel chats are out of scope: the agent talks one to one. */
export function isDirectChat(jid: string | null | undefined): jid is string {
  if (!jid) return false;
  return jid.endsWith(PN_SERVER) || jid.endsWith("@lid");
}

/** Text a person typed: a plain message, a reply or link preview, or a media caption. */
export function messageText(content: proto.IMessage | null | undefined): string {
  if (!content) return "";
  const doc = content.documentWithCaptionMessage?.message?.documentMessage ?? content.documentMessage;
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    doc?.caption ??
    "";
  return text.trim();
}

export type MediaKind = "image" | "audio" | "video" | "document" | "sticker";

export interface MediaInfo {
  kind: MediaKind;
  mimeType?: string;
  name?: string;
  /** Declared size in bytes, when WhatsApp sends it. */
  size?: number;
  /** A voice note recorded in the app, as opposed to an audio file. */
  voiceNote?: boolean;
}

export function mediaInfo(content: proto.IMessage | null | undefined): MediaInfo | undefined {
  if (!content) return undefined;
  const size = (n: unknown) => (n === null || n === undefined ? undefined : Number(n));
  const doc = content.documentWithCaptionMessage?.message?.documentMessage ?? content.documentMessage;
  const pick = (kind: MediaKind, m: { mimetype?: string | null; fileLength?: unknown; fileName?: string | null } | null | undefined, extra: Partial<MediaInfo> = {}) =>
    m ? clean({ kind, mimeType: m.mimetype ?? undefined, name: m.fileName ?? undefined, size: size(m.fileLength), ...extra }) : undefined;
  return (
    pick("image", content.imageMessage) ??
    pick("audio", content.audioMessage, { voiceNote: content.audioMessage?.ptt === true }) ??
    pick("video", content.videoMessage) ??
    pick("document", doc) ??
    pick("sticker", content.stickerMessage)
  );
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
  "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/amr": ".amr",
  "video/mp4": ".mp4", "video/3gpp": ".3gp",
  "application/pdf": ".pdf", "text/plain": ".txt", "text/csv": ".csv", "text/calendar": ".ics", "text/vcard": ".vcf",
};

/** Extension for a saved file: from the MIME type (parameters dropped), else the sender's file name, else .bin. */
export function extensionFor(mimeType: string | undefined, name: string | undefined): string {
  const type = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (type && EXTENSIONS[type]) return EXTENSIONS[type];
  return name?.match(/\.[A-Za-z0-9]{1,8}$/)?.[0]?.toLowerCase() ?? ".bin";
}

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

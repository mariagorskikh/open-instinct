/**
 * WhatsApp as a channel: the agent's own WhatsApp account, joined as a linked device through
 * Baileys (WhatsApp Web's multi-device protocol, over a WebSocket; no browser).
 *
 * Analogy: the agent's WhatsApp Business app on the owner's phone is the account; this process
 * is one more "linked device", like WhatsApp Web on a laptop. The phone holding the account
 * must open WhatsApp at least every 14 days or WhatsApp logs linked devices out.
 *
 * Inbound: one-to-one chats only. Media is downloaded into the inbound folder under a hashed
 * name so open_attachment can read it. Outbound: text, a typing indicator, read receipts.
 * Baileys is unofficial; keep the account for the agent alone and never bulk-message from it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeWASocket,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { InboundMessage, Outbox, OutboundMessage } from "@open-instinct/core";
import { conversationKeyFor, extensionFor, isDirectChat, jidFromConversationKey, jidFromPhone, mediaInfo, messageText, phoneFromJid } from "./parse.js";

export const WHATSAPP_MEDIA_MAX_BYTES = 16 * 1024 * 1024;
const OPEN_WAIT_MS = 30_000;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 5 * 60_000;
/** Fresh pairing codes to offer after one expires unused, before waiting for a restart. */
const PAIRING_ATTEMPTS = 3;
const VERSION_FETCH_MS = 10_000;
/** WebMessageInfo.StubType.CIPHERTEXT: a message Baileys received but could not decrypt. */
const CIPHERTEXT_STUB = 2;

export type WhatsAppState = "idle" | "connecting" | "pairing" | "open" | "closed" | "logged_out";

export interface WhatsAppChannelOptions {
  /** Where the linked-device credentials live. Treat it like a password. */
  authDir: string;
  /** Where inbound media is saved (workspace/inbound). */
  mediaDir: string;
  /** The agent's own WhatsApp number (E.164). Needed once, to print a pairing code. */
  phone?: string;
  /** Called for every message from a person. The caller persists it before acting. */
  onInbound: (msg: InboundMessage) => void | Promise<void>;
  logger?: (m: string) => void;
  maxMediaBytes?: number;
}

export class WhatsAppChannel implements Outbox {
  private sock?: WASocket;
  private state: WhatsAppState = "idle";
  private stopped = false;
  private retryMs = RECONNECT_MIN_MS;
  private retryTimer?: NodeJS.Timeout;
  private pairingAttempts = 0;
  private waVersion?: [number, number, number];
  private openWaiters: Array<() => void> = [];
  private readonly log: (m: string) => void;

  constructor(private readonly opts: WhatsAppChannelOptions) {
    this.log = opts.logger ?? (() => {});
  }

  status(): WhatsAppState {
    return this.state;
  }

  async start(): Promise<void> {
    this.stopped = false;
    mkdirSync(this.opts.authDir, { recursive: true, mode: 0o700 });
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.sock?.end(undefined);
    this.sock = undefined;
    this.state = "closed";
  }

  async send(msg: OutboundMessage): Promise<void> {
    const jid = jidFromConversationKey(msg.conversationKey) ?? (typeof msg.to === "string" ? jidFromPhone(msg.to) : undefined);
    if (!jid) throw new Error("WhatsApp send needs a whatsapp: conversation or a phone number");
    const sock = await this.openSocket();
    const text = msg.text.trim();
    if (text) await sock.sendMessage(jid, { text });
    for (const url of msg.mediaUrls ?? []) await sock.sendMessage(jid, { text: url });
    await sock.sendPresenceUpdate("paused", jid).catch(() => undefined);
  }

  async typing(conversationKey: string): Promise<void> {
    const jid = jidFromConversationKey(conversationKey);
    if (!jid || this.state !== "open" || !this.sock) return;
    await this.sock.sendPresenceUpdate("composing", jid).catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const { state: auth, saveCreds } = await useMultiFileAuthState(this.opts.authDir);
    const version = await this.webVersion();
    const sock = makeWASocket({
      auth,
      ...(version ? { version } : {}),
      logger: baileysLogger(this.log),
      // A real browser name: the phone checks it when linking by code, and an unknown one
      // ("other web client") is refused with "Couldn't link device". The phone lists it as "Chrome (Ubuntu)".
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      // Keep the default history-sync policy: it carries the LID-to-phone map new links need.
      // Old messages arrive as "append", not "notify", so receive() never acts on them.
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    this.state = "connecting";
    let pairingRequested = false;

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (update) => {
      if (update.qr && !auth.creds.registered && !pairingRequested) {
        pairingRequested = true;
        this.state = "pairing";
        void this.requestPairing(sock);
      }
      if (update.connection === "open") {
        this.state = "open";
        this.retryMs = RECONNECT_MIN_MS;
        this.pairingAttempts = 0;
        this.log(`whatsapp: connected as ${phoneFromJid(sock.user?.id) ?? sock.user?.id ?? "unknown"}`);
        for (const wake of this.openWaiters.splice(0)) wake();
      }
      if (update.connection === "close") this.onClose(sock, update.lastDisconnect?.error, Boolean(auth.creds.registered));
    });
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") {
        const fresh = messages.filter((m) => !m.key?.fromMe && isDirectChat(m.key?.remoteJid) && Date.now() / 1000 - Number(m.messageTimestamp ?? 0) < 120);
        if (fresh.length) this.log(`whatsapp: ${fresh.length} recent message(s) arrived as "${type}" (history), not acted on`);
        return;
      }
      for (const m of messages) void this.receive(sock, m).catch((err: Error) => this.log(`whatsapp: dropped a message: ${err.message}`));
    });
  }

  private async requestPairing(sock: WASocket): Promise<void> {
    if (!this.opts.phone) {
      this.log("whatsapp: not linked yet. Set WHATSAPP_PHONE to the agent's WhatsApp number and restart to get a pairing code.");
      return;
    }
    try {
      const code = await sock.requestPairingCode(this.opts.phone.replace(/\D/g, ""));
      const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
      this.log(`whatsapp: pairing code ${pretty}. On the phone with the agent's WhatsApp: Settings > Linked devices > Link a device > Link with phone number instead. It shows up as "Chrome (Ubuntu)".`);
    } catch (err) {
      this.log(`whatsapp: could not get a pairing code: ${(err as Error).message}`);
    }
  }

  private onClose(sock: WASocket, error: unknown, registered: boolean): void {
    if (this.sock !== sock) return;
    const code = (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
    if (code === DisconnectReason.loggedOut && registered) {
      // The phone unlinked us (or WhatsApp did). The saved login is dead; clear it so a restart pairs afresh.
      this.state = "logged_out";
      this.clearAuth();
      this.log("whatsapp: logged out by WhatsApp. Restart to get a new pairing code.");
      return;
    }
    if (!registered && code !== DisconnectReason.restartRequired) {
      // Pairing never finished (the code expired, 408, or was refused). Reconnecting with the half-made
      // login only earns a 401, so start clean and offer a fresh code, a few times at most.
      this.clearAuth();
      if (this.stopped) return;
      this.pairingAttempts += 1;
      if (this.pairingAttempts >= PAIRING_ATTEMPTS) {
        this.state = "closed";
        this.log(`whatsapp: pairing did not complete after ${PAIRING_ATTEMPTS} codes. Restart to try again, and enter the code within two minutes.`);
        return;
      }
      this.state = "closed";
      this.log(`whatsapp: pairing code expired unused (${code ?? "no code"}); issuing a new one`);
      this.retryTimer = setTimeout(() => void this.connect().catch((err: Error) => this.log(`whatsapp: reconnect failed: ${err.message}`)), RECONNECT_MIN_MS);
      return;
    }
    this.state = "closed";
    if (this.stopped) return;
    // After pairing WhatsApp asks for a fresh connection (515); that one should be immediate.
    const delay = code === DisconnectReason.restartRequired ? 0 : this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
    if (delay > 0) this.log(`whatsapp: connection closed (${code ?? "no code"}); retrying in ${Math.round(delay / 1000)}s`);
    this.retryTimer = setTimeout(() => void this.connect().catch((err: Error) => this.log(`whatsapp: reconnect failed: ${err.message}`)), delay);
  }

  /** Empty the credentials folder, keeping the folder itself. */
  private clearAuth(): void {
    rmSync(this.opts.authDir, { recursive: true, force: true });
    mkdirSync(this.opts.authDir, { recursive: true, mode: 0o700 });
  }

  /**
   * The WhatsApp Web revision to claim. The one baked into Baileys ages between releases and
   * WhatsApp refuses stale clients, so ask web.whatsapp.com once; fall back to the default.
   */
  private async webVersion(): Promise<[number, number, number] | undefined> {
    if (this.waVersion) return this.waVersion;
    try {
      const { version, isLatest } = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(VERSION_FETCH_MS) });
      if (isLatest) this.waVersion = version as [number, number, number];
    } catch {
      // Offline or blocked: Baileys' own default still works most of the time.
    }
    return this.waVersion;
  }

  private async openSocket(): Promise<WASocket> {
    if (this.state === "open" && this.sock) return this.sock;
    if (this.state === "logged_out" || this.stopped) throw new Error(`WhatsApp is ${this.state === "logged_out" ? "logged out" : "stopped"}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WhatsApp is not connected")), OPEN_WAIT_MS);
      this.openWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.sock!;
  }

  private async receive(sock: WASocket, m: WAMessage): Promise<void> {
    const key = m.key;
    if (!key?.id || key.fromMe || !isDirectChat(key.remoteJid)) return;
    if (m.messageStubType === CIPHERTEXT_STUB) {
      // Baileys could not decrypt it and has asked the sender's phone to send it again.
      this.log(`whatsapp: a message from ${key.remoteJid} could not be decrypted (${m.messageStubParameters?.[0] ?? "no reason given"}); waiting for the phone to resend it`);
      return;
    }
    const content = normalizeMessageContent(m.message);
    let text = messageText(content);
    const media = mediaInfo(content);
    if (!text && !media) return; // reactions, receipts, protocol messages

    const chat = key.remoteJid;
    // Chats addressed by LID (WhatsApp's privacy id) carry the phone number alongside, or in the LID map.
    const from =
      phoneFromJid(chat) ??
      phoneFromJid(key.remoteJidAlt) ??
      phoneFromJid(await sock.signalRepository.lidMapping.getPNForLID(chat).catch(() => null));
    if (!from) {
      this.log(`whatsapp: ignored a message from ${chat}: no phone number for this sender`);
      return;
    }

    const attachments: NonNullable<InboundMessage["attachments"]> = [];
    if (media) {
      const cap = this.opts.maxMediaBytes ?? WHATSAPP_MEDIA_MAX_BYTES;
      try {
        if (media.size !== undefined && media.size > cap) throw new Error("too large");
        const bytes = await downloadMediaMessage(m, "buffer", {}, { logger: baileysLogger(this.log), reuploadRequest: sock.updateMediaMessage });
        if (bytes.length > cap) throw new Error("too large");
        mkdirSync(this.opts.mediaDir, { recursive: true, mode: 0o700 });
        // The same naming as the Inkbox hydrator: open_attachment only opens 64-hex names it could have written.
        const hash = createHash("sha256").update(`whatsapp\n${chat}\n${key.id}`).digest("hex");
        const file = path.join(this.opts.mediaDir, `${hash}${extensionFor(media.mimeType, media.name)}`);
        writeFileSync(file, bytes, { mode: 0o600 });
        attachments.push({ path: file, ...(media.mimeType ? { mimeType: media.mimeType } : {}), ...(media.name ? { name: media.name } : {}) });
        if (media.voiceNote && !text) text = "[voice note]";
      } catch (err) {
        text += `${text ? "\n" : ""}[A ${media.voiceNote ? "voice note" : media.kind} could not be downloaded: ${(err as Error).message}]`;
      }
    }

    const sentAt = Number(m.messageTimestamp ?? 0);
    this.log(`whatsapp: message from ${from}${media ? ` (${media.voiceNote ? "voice note" : media.kind})` : ""}`);
    const msg: InboundMessage = {
      id: `whatsapp:${key.id}`,
      channel: "whatsapp",
      conversationKey: conversationKeyFor(chat),
      from,
      text: text || "[attachment]",
      ...(attachments.length ? { attachments } : {}),
      replyRef: { chatJid: chat, messageId: key.id },
      receivedAt: (sentAt > 0 ? new Date(sentAt * 1000) : new Date()).toISOString(),
      source: "whatsapp",
      meta: { isGroup: false, participants: [from], conversationScopeKnown: true, ...(m.pushName ? { pushName: m.pushName } : {}) },
    };
    await this.opts.onInbound(msg);
    await sock.readMessages([key]).catch(() => undefined);
  }
}

/** Baileys logs a great deal at info; keep warnings and errors, prefixed, and drop the rest. */
function baileysLogger(log: (m: string) => void) {
  const emit = (level: string) => (obj: unknown, msg?: string) => {
    const text = msg ?? (typeof obj === "string" ? obj : (obj as { msg?: string; err?: { message?: string } })?.msg ?? (obj as { err?: { message?: string } })?.err?.message);
    if (text) log(`whatsapp ${level}: ${text}`);
  };
  const quiet = () => {};
  const logger = { level: "warn", child: () => logger, trace: quiet, debug: quiet, info: quiet, warn: emit("warn"), error: emit("error") };
  return logger;
}

import { describe, expect, it } from "vitest";
import { conversationKeyFor, extensionFor, isDirectChat, jidFromConversationKey, jidFromPhone, mediaInfo, messageText, phoneFromJid } from "../src/parse.js";

describe("addresses", () => {
  it("maps phone-number JIDs to E.164, dropping the device suffix", () => {
    expect(phoneFromJid("447700900123@s.whatsapp.net")).toBe("+447700900123");
    expect(phoneFromJid("447700900123:12@s.whatsapp.net")).toBe("+447700900123");
    expect(phoneFromJid("123456789012345@lid")).toBeUndefined();
    expect(phoneFromJid("120363000000000000@g.us")).toBeUndefined();
    expect(phoneFromJid(null)).toBeUndefined();
  });

  it("builds JIDs from phones and round-trips conversation keys", () => {
    expect(jidFromPhone("+44 7700 900123")).toBe("447700900123@s.whatsapp.net");
    expect(() => jidFromPhone("not a phone")).toThrow();
    const key = conversationKeyFor("447700900123@s.whatsapp.net");
    expect(key).toBe("whatsapp:447700900123@s.whatsapp.net");
    expect(jidFromConversationKey(key)).toBe("447700900123@s.whatsapp.net");
    expect(jidFromConversationKey("imessage:abc")).toBeUndefined();
  });

  it("talks one to one only: no groups, broadcasts, status or channels", () => {
    expect(isDirectChat("447700900123@s.whatsapp.net")).toBe(true);
    expect(isDirectChat("123456789012345@lid")).toBe(true);
    for (const jid of ["120363000000000000@g.us", "status@broadcast", "1234@broadcast", "1234@newsletter", undefined]) expect(isDirectChat(jid), String(jid)).toBe(false);
  });
});

describe("message content", () => {
  it("reads plain text, replies and captions", () => {
    expect(messageText({ conversation: " hello " })).toBe("hello");
    expect(messageText({ extendedTextMessage: { text: "see link" } })).toBe("see link");
    expect(messageText({ imageMessage: { caption: "the hearth" } })).toBe("the hearth");
    expect(messageText({ documentWithCaptionMessage: { message: { documentMessage: { caption: "invoice" } } } })).toBe("invoice");
    expect(messageText({ reactionMessage: { text: "👍" } })).toBe("");
    expect(messageText(undefined)).toBe("");
  });

  it("describes media, marking recorded voice notes", () => {
    expect(mediaInfo({ audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true, fileLength: 4096 } })).toEqual({ kind: "audio", mimeType: "audio/ogg; codecs=opus", size: 4096, voiceNote: true });
    expect(mediaInfo({ imageMessage: { mimetype: "image/jpeg", caption: "x" } })).toEqual({ kind: "image", mimeType: "image/jpeg" });
    expect(mediaInfo({ documentMessage: { mimetype: "application/pdf", fileName: "Lease.pdf" } })).toEqual({ kind: "document", mimeType: "application/pdf", name: "Lease.pdf" });
    expect(mediaInfo({ conversation: "hi" })).toBeUndefined();
  });

  it("picks the saved file's extension from the type, then the name", () => {
    expect(extensionFor("audio/ogg; codecs=opus", undefined)).toBe(".ogg");
    expect(extensionFor("image/jpeg", "IMG_1.HEIC")).toBe(".jpg");
    expect(extensionFor("application/octet-stream", "Plan.DOCX")).toBe(".docx");
    expect(extensionFor(undefined, undefined)).toBe(".bin");
  });
});

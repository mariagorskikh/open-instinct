import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContactStore, PolicyEngine, StateDir, defaultConfig, defaultPolicy, type InstinctConfig, type OutboundMessage, type Principal, type ToolContext } from "@open-instinct/core";
import type { FileSend, InkboxChannel } from "../src/channel.js";
import { messagingTools, phoneCallTool, resolveTarget, sendFileTool, type MessagingDeps } from "../src/tools.js";

let dir: string;
let contacts: ContactStore;
let config: InstinctConfig;
let sent: Array<{ msg: OutboundMessage; ctx: { principal: Principal; conversationKey: string } }>;
let channel: InkboxChannel;

const owner: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Maria", phone: "+14155550000" };
const friend: Principal = { kind: "contact", id: "contact:sam-lee", tier: "friend", displayName: "Sam Lee", contactId: "sam-lee", phone: "+14155550100" };
const ctxFor = (principal: Principal, conversationKey: string): ToolContext => ({
  principal,
  conversationKey,
  channel: conversationKey.split(":")[0] as ToolContext["channel"],
  now: () => new Date("2026-10-03T12:00:00Z"),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inkbox-tools-"));
  const state = new StateDir(dir);
  state.ensure();
  contacts = new ContactStore(state);
  contacts.upsert({ name: "Sam Lee", phones: ["415-555-0100"], emails: ["sam@example.com"], tier: "friend" });
  contacts.upsert({ name: "Priya Patel", emails: ["priya@example.com"], tier: "contact" });
  contacts.upsert({ name: "Sam Jones", phones: ["+14155550199"], tier: "contact" });
  config = defaultConfig();
  config.owner = { ...config.owner, name: "Maria", phones: ["+14155550000"], emails: ["maria@example.com"] };
  sent = [];
  channel = {
    send: vi.fn(async (msg: OutboundMessage, ctx: { principal: Principal; conversationKey: string }) => {
      sent.push({ msg, ctx });
    }),
    typing: vi.fn(async () => undefined),
    react: vi.fn(async () => undefined),
  } as unknown as InkboxChannel;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function tool(name: string) {
  const t = messagingTools({ channel, contacts, config }).find((x) => x.spec.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t.spec;
}

describe("resolveTarget", () => {
  it("resolves owner, contact ids, names, phones and emails", () => {
    const deps = { contacts, config };
    expect(resolveTarget("owner", deps)).toEqual({ channel: "imessage", to: "+14155550000", label: "Maria" });
    expect(resolveTarget("owner", deps, "email")).toEqual({ channel: "email", to: "maria@example.com", label: "Maria" });
    expect(resolveTarget("sam-lee", deps)).toEqual({ channel: "imessage", to: "+14155550100", label: "Sam Lee" });
    expect(resolveTarget("sam-lee", deps, "sms")).toEqual({ channel: "sms", to: "+14155550100", label: "Sam Lee" });
    expect(resolveTarget("sam-lee", deps, "email")).toEqual({ channel: "email", to: "sam@example.com", label: "Sam Lee" });
    expect(resolveTarget("Priya Patel", deps)).toEqual({ channel: "email", to: "priya@example.com", label: "Priya Patel" });
    expect(resolveTarget("(415) 555-0100", deps)).toEqual({ channel: "imessage", to: "+14155550100", label: "Sam Lee" });
    expect(resolveTarget("+1 650 555 0001", deps)).toEqual({ channel: "imessage", to: "+16505550001", label: "+16505550001" });
    expect(resolveTarget("Someone@Example.com", deps)).toEqual({ channel: "email", to: "someone@example.com", label: "Someone@Example.com" });
  });

  it("refuses ambiguous names, unknown people and missing addresses", () => {
    const deps = { contacts, config };
    expect(() => resolveTarget("Sam", deps)).toThrow(/several contacts/);
    expect(() => resolveTarget("nobody", deps)).toThrow(/no contact/);
    expect(() => resolveTarget("priya-patel", deps, "imessage")).toThrow(/no phone/);
    expect(() => resolveTarget("", deps)).toThrow(/empty/);
    const noPhoneOwner = { contacts, config: { ...config, owner: { ...config.owner, phones: [] } } };
    expect(resolveTarget("owner", noPhoneOwner).channel).toBe("email");
  });
});

describe("send_message", () => {
  it("replies in the current conversation when `to` is omitted", async () => {
    const r = await tool("send_message").execute({ text: "On my way" }, ctxFor(owner, "imessage:conv_1"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.msg).toEqual({ channel: "imessage", conversationKey: "imessage:conv_1", text: "On my way" });
    expect(sent[0]?.ctx.conversationKey).toBe("imessage:conv_1");
    expect(JSON.stringify(r)).toContain("imessage");
  });

  it("hands a chat reply to the owner relay when one is wired, and refuses otherwise", async () => {
    const relayed: string[] = [];
    const withRelay = messagingTools({ channel, contacts, config, sendToOwner: async (text) => { relayed.push(text); } }).find((x) => x.spec.name === "send_message")!;
    const r = await withRelay.spec.execute({ text: "On it" }, ctxFor(owner, "chat:chat:sim-1"));
    expect(relayed).toEqual(["On it"]);
    expect(JSON.stringify(r)).toContain("Queued for the owner");
    expect(sent).toHaveLength(0);
    await expect(tool("send_message").execute({ text: "On it" }, ctxFor(owner, "chat:chat:sim-1"))).rejects.toThrow(/Cannot reply on/);
  });

  it("uses the delivery conversation and reply reference instead of the internal session key", async () => {
    await tool("send_message").execute({ text: "Hi everyone" }, {
      ...ctxFor(owner, "imessage:group_1:owner"), deliveryKey: "imessage:group_1",
    });
    expect(sent[0]?.msg.conversationKey).toBe("imessage:group_1");
    const replyRef = { from: "sam@example.com", subject: "Plans", messageId: "<original@example.com>" };
    await tool("send_message").execute({ text: "Thursday works" }, {
      ...ctxFor(owner, "email:thread_1"), deliveryKey: "email:thread_1", replyRef,
    });
    expect(sent[1]?.msg.replyRef).toEqual(replyRef);
  });

  it("uses the wire conversation for typing and reactions in group sessions", async () => {
    const ctx = { ...ctxFor(owner, "imessage:group_1:owner"), deliveryKey: "imessage:group_1" };
    await tool("send_typing").execute({}, ctx);
    await tool("react").execute({ messageId: "message_1", reaction: "like" }, ctx);
    expect(channel.typing).toHaveBeenCalledWith("imessage:group_1");
    expect(channel.react).toHaveBeenCalledWith("imessage:group_1", "message_1", "like");
  });

  it("lets the owner message a contact, a number, or an email with a subject", async () => {
    const t = tool("send_message");
    await t.execute({ to: "sam-lee", text: "Dinner Thursday?" }, ctxFor(owner, "chat:cli"));
    await t.execute({ to: "+14155550199", channel: "sms", text: "hi" }, ctxFor(owner, "chat:cli"));
    await t.execute({ to: "priya@example.com", text: "Hello Priya", subject: "Intro" }, ctxFor(owner, "chat:cli"));
    expect(sent[0]?.msg).toEqual({ channel: "imessage", to: "+14155550100", text: "Dinner Thursday?" });
    expect(sent[1]?.msg).toEqual({ channel: "sms", to: "+14155550199", text: "hi" });
    expect(sent[2]?.msg).toMatchObject({ channel: "email", to: "priya@example.com", text: "Hello Priya", replyRef: { subject: "Intro" } });
  });

  it("blocks a non-owner from messaging third parties but lets them reply here or reach the owner", async () => {
    const t = tool("send_message");
    await expect(t.execute({ to: "priya-patel", text: "hey" }, ctxFor(friend, "imessage:conv_sam"))).rejects.toThrow(/may only reply here/);
    await expect(t.execute({ to: "+16505550001", text: "hey" }, ctxFor(friend, "imessage:conv_sam"))).rejects.toThrow(/may only reply here/);
    expect(sent).toHaveLength(0);

    await t.execute({ text: "sure, 7pm" }, ctxFor(friend, "imessage:conv_sam"));
    expect(sent[0]?.msg).toEqual({ channel: "imessage", conversationKey: "imessage:conv_sam", text: "sure, 7pm" });

    await t.execute({ to: "owner", text: "Tell Maria I said hi" }, ctxFor(friend, "imessage:conv_sam"));
    expect(sent[1]?.msg).toEqual({ channel: "imessage", to: "+14155550000", text: "From Sam Lee: Tell Maria I said hi" });
    expect(sent[1]?.ctx.principal).toBe(friend);
  });

  it("refuses to reply on chat or a2a threads without `to`, and rejects empty text", async () => {
    const t = tool("send_message");
    await expect(t.execute({ text: "x" }, ctxFor(owner, "chat:dashboard"))).rejects.toThrow(/Give `to`/);
    await expect(t.execute({ text: "x" }, ctxFor(friend, "a2a:ctx_1"))).rejects.toThrow(/reply_instinct/);
    const r = await t.execute({ text: "   " }, ctxFor(owner, "imessage:c"));
    expect(typeof r === "object" && r.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("tags the tools with converse and the messaging group", () => {
    for (const name of ["send_message", "send_typing", "react"]) {
      expect(tool(name).meta).toMatchObject({ capabilities: ["converse"], group: "messaging" });
    }
    expect(tool("send_message").meta.describe?.({ to: "sam-lee", text: "hello there" })).toBe("send_message to sam-lee: hello there");
  });
});

describe("send_typing and react", () => {
  it("forward to the channel with the current conversation", async () => {
    await tool("send_typing").execute({}, ctxFor(owner, "imessage:conv_1"));
    expect(channel.typing).toHaveBeenCalledWith("imessage:conv_1");
    await tool("react").execute({ messageId: "msg_1", reaction: "love" }, ctxFor(friend, "imessage:conv_1"));
    expect(channel.react).toHaveBeenCalledWith("imessage:conv_1", "msg_1", "love");
  });
});

describe("send_file", () => {
  const PDF = Buffer.from("%PDF-1.4\n%test\n");
  let sentFiles: Array<{ file: FileSend; ctx: { principal: Principal; conversationKey: string } }>;
  let dataDir: string;
  let workspace: string;

  beforeEach(() => {
    sentFiles = [];
    dataDir = realpathSync(dir);
    workspace = join(dataDir, "workspace");
    mkdirSync(join(workspace, "research"), { recursive: true });
    writeFileSync(join(workspace, "research", "brief.pdf"), PDF);
    writeFileSync(join(dataDir, "inbox", "photo.jpg"), Buffer.from([0xff, 0xd8]));
    (channel as unknown as { sendFile: unknown }).sendFile = vi.fn(async (file: FileSend, ctx: { principal: Principal; conversationKey: string }) => {
      sentFiles.push({ file, ctx });
      return { channel: file.channel };
    });
  });

  function fileTool(extra: Partial<MessagingDeps> = {}) {
    const t = messagingTools({ channel, contacts, config, dataDir, ...extra }).find((x) => x.spec.name === "send_file");
    if (!t) throw new Error("missing send_file");
    return t.spec;
  }
  const text = (r: Awaited<ReturnType<ReturnType<typeof fileTool>["execute"]>>) => (typeof r === "string" ? r : r.content.map((c) => (c.type === "text" ? c.text : "")).join(""));

  it("is tagged converse plus files.read in the messaging group", () => {
    expect(fileTool().meta).toMatchObject({ capabilities: ["converse", "files.read"], group: "messaging" });
    expect(fileTool().meta.describe?.({ path: "research/brief.pdf" })).toBe("send_file research/brief.pdf to current conversation");
  });

  it("sends a workspace-relative file in the current iMessage conversation with the caption", async () => {
    const r = await fileTool().execute({ path: "research/brief.pdf", caption: "Here is the brief as a PDF." }, ctxFor(owner, "imessage:conv_1"));
    expect(text(r)).toBe("Sent brief.pdf in the current imessage conversation.");
    expect(sentFiles).toHaveLength(1);
    expect(sentFiles[0]?.file).toEqual({ channel: "imessage", conversationKey: "imessage:conv_1", filename: "brief.pdf", contentType: "application/pdf", content: PDF, caption: "Here is the brief as a PDF." });
    expect(sentFiles[0]?.ctx).toEqual({ principal: owner, conversationKey: "imessage:conv_1" });
  });

  it("emails a contact with subject and caption, and defaults the subject for new threads", async () => {
    const t = fileTool();
    await t.execute({ path: "research/brief.pdf", to: "priya-patel", caption: "As promised.", subject: "Research brief" }, ctxFor(owner, "chat:cli"));
    expect(sentFiles[0]?.file).toEqual({ channel: "email", to: "priya@example.com", filename: "brief.pdf", contentType: "application/pdf", content: PDF, caption: "As promised.", subject: "Research brief" });
    await t.execute({ path: "research/brief.pdf", to: "owner", channel: "email" }, ctxFor(owner, "chat:cli"));
    expect(sentFiles[1]?.file).toMatchObject({ channel: "email", to: "maria@example.com", subject: "brief.pdf from your Instinct" });
    expect(sentFiles[1]?.file.caption).toBeUndefined();
    await t.execute({ path: "research/brief.pdf", to: "sam-lee", channel: "sms" }, ctxFor(owner, "chat:cli"));
    expect(sentFiles[2]?.file).toMatchObject({ channel: "sms", to: "+14155550100" });
    expect(sentFiles[2]?.file.subject).toBeUndefined();
  });

  it("returns a maritime-file fence for dashboard chat instead of sending", async () => {
    const r = await fileTool().execute({ path: "research/brief.pdf", caption: "Here is the brief as a PDF.", subject: "Research brief" }, ctxFor(owner, "chat:dashboard"));
    const out = text(r);
    expect(sentFiles).toHaveLength(0);
    const m = /```maritime-file\n(.*)\n```/.exec(out);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]!)).toEqual({ path: join(workspace, "research", "brief.pdf"), name: "brief.pdf", size: PDF.length, mime: "application/pdf", title: "Research brief", message: "Here is the brief as a PDF." });
    expect(out.startsWith(join(workspace, "research", "brief.pdf"))).toBe(true);
    const plain = await fileTool().execute({ path: "research/brief.pdf" }, ctxFor(owner, "chat:cli"));
    expect(JSON.parse(/```maritime-file\n(.*)\n```/.exec(text(plain))![1]!)).toEqual({ path: join(workspace, "research", "brief.pdf"), name: "brief.pdf", size: PDF.length, mime: "application/pdf" });
  });

  it("lets a non-owner send only into their own conversation or to the owner", async () => {
    const t = fileTool();
    await expect(t.execute({ path: "research/brief.pdf", to: "priya-patel" }, ctxFor(friend, "imessage:conv_sam"))).rejects.toThrow(/may only send files here/);
    await expect(t.execute({ path: "research/brief.pdf", to: "+16505550001" }, ctxFor(friend, "imessage:conv_sam"))).rejects.toThrow(/may only send files here/);
    expect(sentFiles).toHaveLength(0);
    await t.execute({ path: "research/brief.pdf" }, ctxFor(friend, "imessage:conv_sam"));
    expect(sentFiles[0]?.file).toMatchObject({ channel: "imessage", conversationKey: "imessage:conv_sam", filename: "brief.pdf" });
    await t.execute({ path: "research/brief.pdf", to: "owner", caption: "for Maria" }, ctxFor(friend, "imessage:conv_sam"));
    expect(sentFiles[1]?.file).toMatchObject({ channel: "imessage", to: "+14155550000", caption: "From Sam Lee: for Maria" });
    await t.execute({ path: "research/brief.pdf", to: "owner", channel: "email" }, ctxFor(friend, "imessage:conv_sam"));
    expect(sentFiles[2]?.file).toMatchObject({ channel: "email", to: "maria@example.com", subject: "File from Sam Lee", caption: "From Sam Lee: brief.pdf" });
  });

  it("accepts absolute paths under the data dir and refuses everything outside it", async () => {
    const t = fileTool();
    await t.execute({ path: join(dataDir, "inbox", "photo.jpg") }, ctxFor(owner, "imessage:conv_1"));
    expect(sentFiles[0]?.file).toMatchObject({ filename: "photo.jpg", contentType: "image/jpeg" });
    const outside = mkdtempSync(join(tmpdir(), "inkbox-outside-"));
    writeFileSync(join(outside, "secret.txt"), "x");
    try {
      for (const bad of ["../../" + basename(outside) + "/secret.txt", join(outside, "secret.txt"), "../memory/MEMORY.md", "/etc/hosts"]) {
        const r = await t.execute({ path: bad }, ctxFor(owner, "imessage:conv_1"));
        expect(typeof r === "object" && r.isError, bad).toBe(true);
        expect(text(r), bad).toMatch(/outside the data directory|no file at/);
      }
      // A symlink inside the workspace pointing outside is followed and refused.
      symlinkSync(join(outside, "secret.txt"), join(workspace, "link.txt"));
      const viaLink = await t.execute({ path: "link.txt" }, ctxFor(owner, "imessage:conv_1"));
      expect(text(viaLink)).toMatch(/outside the data directory/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    const missing = await t.execute({ path: "research/nope.pdf" }, ctxFor(owner, "imessage:conv_1"));
    expect(text(missing)).toMatch(/no file at research\/nope\.pdf/);
    const folder = await t.execute({ path: "research" }, ctxFor(owner, "imessage:conv_1"));
    expect(text(folder)).toMatch(/not a file/);
    expect(sentFiles).toHaveLength(1);
    const unconfigured = await fileTool({ dataDir: undefined }).execute({ path: "research/brief.pdf" }, ctxFor(owner, "imessage:conv_1"));
    expect(text(unconfigured)).toMatch(/not configured/);
  });

  it("works without a channel: the dashboard chat still gets the file, wires are refused", async () => {
    const alone = sendFileTool({ contacts, config, dataDir }).spec;
    expect(alone.name).toBe("send_file");
    const chat = await alone.execute({ path: "research/brief.pdf", caption: "Here it is." }, ctxFor(owner, "chat:default"));
    expect(text(chat)).toContain("```maritime-file");
    expect(text(chat)).toContain(join(workspace, "research", "brief.pdf"));
    await expect(alone.execute({ path: "research/brief.pdf" }, ctxFor(owner, "imessage:conv_1"))).rejects.toThrow(/Inkbox is not configured/);
    await expect(alone.execute({ path: "research/brief.pdf", to: "owner" }, ctxFor(owner, "chat:default"))).rejects.toThrow(/Inkbox is not configured/);
    expect(sentFiles).toHaveLength(0);
  });

  it("refuses to send on a2a or unknown threads without `to`", async () => {
    const t = fileTool();
    await expect(t.execute({ path: "research/brief.pdf" }, ctxFor(friend, "a2a:ctx_1"))).rejects.toThrow(/agent-to-agent/);
    await expect(t.execute({ path: "research/brief.pdf" }, ctxFor(owner, "scheduled:job_1"))).rejects.toThrow(/Give `to`/);
    expect(sentFiles).toHaveLength(0);
  });

  it("passes the size guard to the channel: a file over 10 MiB is rejected by sendFile, not read twice", async () => {
    // The real channel enforces the cap; the tool hands it the bytes and surfaces the error.
    const big = join(workspace, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, 10 * 1024 * 1024 + 1);
    (channel as unknown as { sendFile: unknown }).sendFile = vi.fn(async (file: FileSend) => {
      if (file.channel !== "email" && file.content.length > 10 * 1024 * 1024) throw new Error("big.bin is 10.0 MiB; iMessage attachments are capped at 10.0 MiB. Send it by email instead.");
      sentFiles.push({ file, ctx: { principal: owner, conversationKey: "x" } });
      return { channel: file.channel };
    });
    await expect(fileTool().execute({ path: "big.bin" }, ctxFor(owner, "imessage:conv_1"))).rejects.toThrow(/capped at 10\.0 MiB/);
    await fileTool().execute({ path: "big.bin", to: "owner", channel: "email" }, ctxFor(owner, "imessage:conv_1"));
    expect(sentFiles[0]?.file.content.length).toBe(10 * 1024 * 1024 + 1);
  });
});

describe("phone_call", () => {
  let placed: Array<Record<string, unknown>>;
  let phoneChannel: InkboxChannel;
  beforeEach(() => {
    placed = [];
    phoneChannel = {
      ...channel,
      placeCall: vi.fn(async (input: Record<string, unknown>) => {
        placed.push(input);
        return { id: "call_9", status: "initiated", origination: "shared_imessage_number", minutesRemaining: 12 };
      }),
    } as unknown as InkboxChannel;
  });

  function phone(callOrigination?: "dedicated_number" | "shared_imessage_number" | "dedicated_imessage_number") {
    const t = messagingTools({ channel: phoneChannel, contacts, config, ...(callOrigination ? { callOrigination } : {}) }).find((x) => x.spec.name === "phone_call");
    if (!t) throw new Error("missing phone_call");
    return t.spec;
  }

  it("is a messaging tool gated by phone.call only", () => {
    const spec = phone();
    expect(spec.meta).toMatchObject({ capabilities: ["phone.call"], group: "messaging" });
    expect(spec.meta?.describe?.({ toNumber: "+14155550123", reason: "Book a table for 4 at 7pm under Maria" })).toBe("phone_call +14155550123: Book a table for 4 at 7pm under Maria");
  });

  it("places a hosted-agent call and returns the call id, status and the plan minutes left, nothing else", async () => {
    const r = await phone().execute({ toNumber: "(415) 555-0123", reason: "  Book a table for 4 at 7pm under Maria. " }, ctxFor(owner, "imessage:conv_1"));
    expect(r).toEqual({ content: [{ type: "text", text: "Call call_9: initiated. 12 call minutes left on the plan this month." }] });
    expect(placed).toEqual([{ toNumber: "+14155550123", reason: "Book a table for 4 at 7pm under Maria." }]);
  });

  it("leaves the minutes out when Inkbox returned none", async () => {
    phoneChannel = { ...channel, placeCall: vi.fn(async () => ({ id: "call_9", status: "initiated", origination: "shared_imessage_number" })) } as unknown as InkboxChannel;
    const r = await phone().execute({ toNumber: "+14155550123", reason: "Say hi" }, ctxFor(owner, "imessage:conv_1"));
    expect(r).toEqual({ content: [{ type: "text", text: "Call call_9: initiated." }] });
  });

  it("passes the voicemail message and a forced origination through", async () => {
    await phone("dedicated_number").execute({ toNumber: "+14155550123", reason: "Say hi", voicemailMessage: " Maria will call back. " }, ctxFor(owner, "chat:cli"));
    expect(placed[0]).toEqual({ toNumber: "+14155550123", reason: "Say hi", voicemailMessage: "Maria will call back.", origination: "dedicated_number" });
  });

  it("refuses a bad number, an empty brief and an over-long voicemail before placing anything", async () => {
    const ctx = ctxFor(owner, "chat:cli");
    const bad = await phone().execute({ toNumber: "Sam Lee", reason: "Say hi" }, ctx);
    expect(bad).toEqual({ content: [{ type: "text", text: '"Sam Lee" is not a phone number in E.164 form (+14155550100).' }], isError: true });
    expect((await phone().execute({ toNumber: "12345", reason: "Say hi" }, ctx)).isError).toBe(true);
    expect(await phone().execute({ toNumber: "+14155550123", reason: "   " }, ctx)).toEqual({
      content: [{ type: "text", text: "Nothing to say: `reason` is empty. Give Voice AI the task for the call." }],
      isError: true,
    });
    const long = await phone().execute({ toNumber: "+14155550123", reason: "Say hi", voicemailMessage: "v".repeat(1001) }, ctx);
    expect(long).toEqual({ content: [{ type: "text", text: "The voicemail message is 1001 characters; Inkbox allows 1000." }], isError: true });
    const essay = await phone().execute({ toNumber: "+14155550123", reason: "r".repeat(2001) }, ctx);
    expect(essay).toEqual({ content: [{ type: "text", text: "The reason is 2001 characters; keep the brief under 2000." }], isError: true });
    expect(placed).toEqual([]);
  });

  it("surfaces Inkbox's refusal as the tool error (a plan limit, for example)", async () => {
    (phoneChannel.placeCall as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Inkbox 402: call minutes exhausted"));
    await expect(phone().execute({ toNumber: "+14155550123", reason: "Say hi" }, ctxFor(owner, "chat:cli"))).rejects.toThrow(/call minutes exhausted/);
  });

  it("rejects an unknown origination at construction, before any call", () => {
    expect(() => phoneCallTool({ channel: phoneChannel, callOrigination: "carrier_pigeon" as never })).toThrow(/unknown call origination "carrier_pigeon"/);
  });

  it("is held for the owner's yes even when the owner asks, asks for staff, is denied for partners and below, opened by a grant", () => {
    const spec = phone();
    const engine = new PolicyEngine(defaultPolicy(), { now: () => new Date("2026-10-16T12:00:00Z") });
    const args = { toNumber: "+14155550123", reason: "Say hi" };
    // Never "allow" outright: the owner's own thread can carry text the owner did not write.
    const ownerAsk = engine.evaluate(owner, spec.meta!, args);
    expect(ownerAsk.outcome).toBe("ask");
    if (ownerAsk.outcome !== "ask") return;
    expect(ownerAsk.approvalPrompt).toBe("phone_call +14155550123: Say hi. Want me to go ahead?");
    const staff: Principal = { kind: "contact", id: "agent:teammate", tier: "staff", displayName: "Teammate" };
    expect(engine.evaluate(staff, spec.meta!, args)).toMatchObject({ outcome: "ask", approvalPrompt: "Teammate asks: phone_call +14155550123: Say hi. Want me to go ahead?" });
    const partner: Principal = { kind: "contact", id: "contact:sam-lee", tier: "partner", displayName: "Sam Lee", contactId: "sam-lee" };
    expect(engine.evaluate(partner, spec.meta!, args)).toMatchObject({ outcome: "deny", reason: "tier partner may not phone.call" });
    expect(engine.evaluate(friend, spec.meta!, args).outcome).toBe("deny");
    expect(engine.evaluate({ kind: "stranger", id: "stranger:+1", tier: "stranger", displayName: "+1" }, spec.meta!, args).outcome).toBe("deny");
    engine.addGrant({ to: "contact:sam-lee", capabilities: ["phone.call"], note: "may ring the venue" });
    expect(engine.evaluate(partner, spec.meta!, args).outcome).toBe("allow");
    const otherFriend: Principal = { ...friend, id: "contact:sam-jones", contactId: "sam-jones", displayName: "Sam Jones" };
    expect(engine.evaluate(otherFriend, spec.meta!, args).outcome).toBe("deny");
  });
});

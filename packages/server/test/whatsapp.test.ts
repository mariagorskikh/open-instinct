import { describe, expect, it } from "vitest";
import type { Outbox, OutboundMessage, Principal } from "@open-instinct/core";
import { ChannelRouter, whatsappEnabled } from "../src/whatsapp.js";

function recorder() {
  const sent: OutboundMessage[] = [];
  const typed: string[] = [];
  const outbox: Outbox = { send: async (msg) => void sent.push(msg), typing: async (key) => void typed.push(key) };
  return { outbox, sent, typed };
}

const ctx = { principal: { kind: "owner", id: "owner", tier: "owner" } as Principal, conversationKey: "k" };

describe("ChannelRouter", () => {
  it("sends whatsapp replies through WhatsApp and everything else through the default transport", async () => {
    const inkbox = recorder();
    const wa = recorder();
    const router = new ChannelRouter(inkbox.outbox, { whatsapp: wa.outbox });
    await router.send({ channel: "whatsapp", conversationKey: "whatsapp:447700900123@s.whatsapp.net", text: "hi" }, ctx);
    await router.send({ channel: "imessage", conversationKey: "imessage:c1", text: "hello" }, ctx);
    expect(wa.sent.map((m) => m.text)).toEqual(["hi"]);
    expect(inkbox.sent.map((m) => m.text)).toEqual(["hello"]);
    await router.typing("whatsapp:447700900123@s.whatsapp.net");
    await router.typing("imessage:c1");
    expect(wa.typed).toEqual(["whatsapp:447700900123@s.whatsapp.net"]);
    expect(inkbox.typed).toEqual(["imessage:c1"]);
  });
});

describe("whatsappEnabled", () => {
  it("is on with WHATSAPP_ENABLED=1 or the agent's number, off otherwise", () => {
    expect(whatsappEnabled({ WHATSAPP_ENABLED: "1" })).toBe(true);
    expect(whatsappEnabled({ WHATSAPP_PHONE: "+447700900123" })).toBe(true);
    expect(whatsappEnabled({ WHATSAPP_ENABLED: "0" })).toBe(false);
    expect(whatsappEnabled({})).toBe(false);
  });
});

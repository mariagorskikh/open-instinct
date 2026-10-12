/**
 * WhatsApp wiring: when it is on, and how its replies are told apart from Inkbox's.
 * The channel itself lives in @open-instinct/whatsapp.
 */
import type { Outbox, OutboundMessage, Principal } from "@open-instinct/core";

/** On when WHATSAPP_ENABLED=1, or when the agent's WhatsApp number is set. */
export function whatsappEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.WHATSAPP_ENABLED?.trim() === "1" || Boolean(env.WHATSAPP_PHONE?.trim());
}

/**
 * Sends each message through the transport that owns its channel, and everything else
 * through the default one. Typing indicators follow the conversation key's prefix.
 */
export class ChannelRouter implements Outbox {
  constructor(
    private readonly fallback: Outbox,
    private readonly routes: Partial<Record<OutboundMessage["channel"], Outbox>>,
  ) {}

  async send(msg: OutboundMessage, ctx: { principal: Principal; conversationKey: string }): Promise<void> {
    await (this.routes[msg.channel] ?? this.fallback).send(msg, ctx);
  }

  async typing(conversationKey: string): Promise<void> {
    const prefix = conversationKey.split(":", 1)[0] as OutboundMessage["channel"];
    const route = this.routes[prefix];
    await (route ? route.typing?.(conversationKey) : this.fallback.typing?.(conversationKey));
  }
}

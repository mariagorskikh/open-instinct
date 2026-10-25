import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateDir } from "../src/state.js";
import type { InboundMessage, InstinctConfig, Principal, Tier } from "../src/types.js";
import { defaultConfig } from "../src/config.js";

export function tempState(): StateDir {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instinct-core-"));
  const state = new StateDir(root);
  state.ensure();
  return state;
}

export function testConfig(overrides: Partial<InstinctConfig["owner"]> = {}): InstinctConfig {
  const cfg = defaultConfig();
  cfg.owner = {
    name: "Maria",
    phones: ["+16175550100"],
    emails: ["maria@example.com"],
    timezone: "America/New_York",
    ...overrides,
  };
  cfg.agent = { name: "Instinct", handle: "maria-instinct" };
  // Tests run at any hour; the quiet-hours hold is exercised explicitly where it matters.
  cfg.features.quietHours = false;
  return cfg;
}

export function principalOf(tier: Tier, extra: Partial<Principal> = {}): Principal {
  if (tier === "owner") return { kind: "owner", id: "owner", tier, displayName: "Maria", ...extra };
  if (tier === "stranger") return { kind: "stranger", id: "stranger:imessage:+15555550000", tier, displayName: "+15555550000", ...extra };
  return { kind: "contact", id: `contact:${tier}-person`, tier, displayName: `${tier} person`, contactId: `${tier}-person`, ...extra };
}

export function inbound(partial: Partial<InboundMessage> & { from: string; channel: InboundMessage["channel"] }): InboundMessage {
  return {
    id: partial.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    conversationKey: partial.conversationKey ?? `${partial.channel}:test`,
    text: partial.text ?? "hello",
    replyRef: partial.replyRef ?? {},
    receivedAt: partial.receivedAt ?? new Date().toISOString(),
    ...partial,
  };
}

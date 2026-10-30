/**
 * `instinct prompt`: print the system prompt the owner conversation would get right
 * now, built from the local data dir (config, PERSONA.md, AGENTS.md, memory, policy,
 * pending approvals, skills). No server, no model, no key needed. Tool groups and the
 * computer or apps guidance depend on what boots, so this is the owner's view of the
 * prompt's text, not a byte-for-byte copy of a live agent's.
 */
import {
  ALL_CAPABILITIES,
  ApprovalStore,
  MemoryStore,
  PolicyEngine,
  describePromptLayers,
  loadConfig,
  loadPolicy,
  readAgentsInstructions,
  readPersona,
  type Channel,
  type PromptInput,
  type PromptLayer,
} from "@open-instinct/core";
import { flag, parse, str, type OptionSpec } from "../args.js";
import { table } from "../ansi.js";
import type { CliContext } from "../context.js";
import { UsageError } from "../io.js";

export const promptOptions: OptionSpec = {
  channel: { type: "string" },
  layers: { type: "boolean" },
  json: { type: "boolean" },
  "no-skills": { type: "boolean" },
};

const CHANNELS: ReadonlySet<string> = new Set(["imessage", "sms", "whatsapp", "email", "a2a", "chat", "scheduled", "system"]);

/** Tool groups every owner conversation has; messaging, computer and apps depend on keys. */
export const SAMPLE_OWNER_TOOL_GROUPS = ["owner", "memory", "schedule", "web", "files", "contacts", "network"];

/** How the skills index is loaded; overridable so tests do not depend on the repo's skills folder. */
export type SkillsLoader = (env: NodeJS.ProcessEnv) => Promise<string | undefined>;

async function defaultSkillsLoader(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const server = await import("@open-instinct/server");
  // resolveSkillsDir expects a module at <package>/{src,dist}/x.js and looks for
  // <repo>/skills three levels up. This file is one level deeper, so hand it the parent.
  const dir = server.resolveSkillsDir({ env, packageUrl: new URL("..", import.meta.url).href });
  return server.loadSkillsPrompt(dir);
}

export interface PromptPreviewOptions {
  channel?: Channel;
  skills?: SkillsLoader | false;
  now?: Date;
}

/** The PromptInput for the owner's own thread, from the data dir alone. */
export async function ownerPromptInput(ctx: CliContext, opts: PromptPreviewOptions = {}): Promise<PromptInput> {
  const state = ctx.state();
  const config = loadConfig(state, ctx.env);
  const policy = new PolicyEngine(loadPolicy(state));
  const owner = { kind: "owner" as const, id: "owner", tier: "owner" as const, displayName: config.owner.name };
  const skills =
    opts.skills === false
      ? undefined
      : await (opts.skills ?? defaultSkillsLoader)(ctx.env).catch((err: unknown) => {
          ctx.warn(`skills index left out: ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        });
  return {
    config,
    principal: owner,
    channel: opts.channel ?? "imessage",
    now: opts.now ?? new Date(),
    capabilities: ALL_CAPABILITIES.filter((cap) => policy.canEver(owner, cap)),
    // load_skill sits in the system group, so the preview lists it whenever skills are shown.
    toolGroups: skills ? [...SAMPLE_OWNER_TOOL_GROUPS, "system"] : SAMPLE_OWNER_TOOL_GROUPS,
    memoryDigest: new MemoryStore(state).digest(4000, opts.now ?? new Date()),
    persona: readPersona(state),
    instructions: readAgentsInstructions(state),
    skillsPrompt: skills,
    pendingApprovals: new ApprovalStore(state).pending(),
  };
}

export function renderLayerTable(layers: PromptLayer[]): string {
  return table(layers.map((l, i) => [String(i + 1), l.id, `${l.text.length} chars`, l.source]));
}

export async function runPrompt(ctx: CliContext, argv: string[]): Promise<number> {
  const { values } = parse("prompt", argv, promptOptions);
  const channelText = str(values, "channel") ?? "imessage";
  if (!CHANNELS.has(channelText)) throw new UsageError(`--channel must be one of ${[...CHANNELS].join(", ")}`, "prompt");
  const input = await ownerPromptInput(ctx, { channel: channelText as Channel, skills: flag(values, "no-skills") ? false : undefined });
  const layers = describePromptLayers(input);

  if (flag(values, "json")) {
    ctx.print(JSON.stringify({ channel: input.channel, principal: input.principal, layers }, null, 2));
    return 0;
  }
  if (flag(values, "layers")) {
    ctx.print(ctx.c.bold(`System prompt layers for ${input.config.owner.name} on ${input.channel} (data: ${ctx.dataDir})`));
    ctx.print(renderLayerTable(layers));
    ctx.print();
    ctx.print(ctx.c.dim("instinct prompt prints the full text; docs/CUSTOMIZE.md explains how to change each layer."));
    return 0;
  }
  ctx.print(layers.map((l) => l.text).join("\n\n"));
  return 0;
}

/**
 * config.json: who the owner is, which model to use, feature flags. The file wins
 * over the environment after first boot; env only seeds it. Two exceptions
 * operators use without editing state: INSTINCT_MODEL and COMPOSIO_TOOLKITS
 * (the gateway pushes per-person toolkit lists to already-deployed agents).
 */
import { normalizeEmail, normalizeHandle, normalizePhone } from "./principal.js";
import type { StateDir } from "./state.js";
import type { InstinctConfig } from "./types.js";

const FILE = "config.json";

export const DEFAULT_MODEL = "anthropic/claude-fable-5-1";
export const DEFAULT_FALLBACK_MODEL = "anthropic/claude-opus-5-5";
export const DEFAULT_CHEAP_MODEL = "anthropic/claude-sonnet-5-5";
export const DEFAULT_TOOLKITS = ["gmail", "googlecalendar", "googlecontacts"];

function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function defaultConfig(): InstinctConfig {
  return {
    version: 1,
    owner: { name: "Owner", phones: [], emails: [], timezone: systemTimezone() },
    agent: { name: "Instinct" },
    model: { primary: DEFAULT_MODEL, fallback: DEFAULT_FALLBACK_MODEL, cheap: DEFAULT_CHEAP_MODEL, thinking: "medium" },
    computer: { mode: "auto" },
    apps: { enabled: false, toolkits: [...DEFAULT_TOOLKITS] },
    features: { typingIndicators: true, tapbacks: true, journal: true },
  };
}

/** Comma-separated env values. Phones contain spaces, so whitespace is not a separator. */
function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const COMPUTER_MODES = new Set<InstinctConfig["computer"]["mode"]>(["auto", "desktopd", "maritime", "none"]);

/** Build a fresh config from the environment. Used only when config.json is missing. */
export function configFromEnv(env: NodeJS.ProcessEnv): InstinctConfig {
  const cfg = defaultConfig();
  if (env.INSTINCT_OWNER_NAME?.trim()) cfg.owner.name = env.INSTINCT_OWNER_NAME.trim();
  cfg.owner.phones = splitList(env.INSTINCT_OWNER_PHONE).map(normalizePhone).filter(Boolean);
  cfg.owner.emails = splitList(env.INSTINCT_OWNER_EMAIL).map(normalizeEmail).filter(Boolean);
  if (/^(1|true|yes)$/i.test((env.INSTINCT_CLAIM_OWNER_ON_FIRST_CONTACT ?? "").trim())) cfg.owner.claimOnFirstContact = true;
  // The claim only works with a one-time code; see owner-claim.ts.
  if (env.INSTINCT_OWNER_CLAIM_CODE?.trim()) cfg.owner.claimCode = env.INSTINCT_OWNER_CLAIM_CODE.trim();
  if (env.INSTINCT_OWNER_CLAIM_EXPIRES_AT?.trim()) cfg.owner.claimExpiresAt = env.INSTINCT_OWNER_CLAIM_EXPIRES_AT.trim();
  // INSTINCT_TIMEZONE is the name older .env.example files used; keep honouring it.
  const timezone = env.INSTINCT_OWNER_TIMEZONE?.trim() || env.INSTINCT_TIMEZONE?.trim();
  if (timezone) cfg.owner.timezone = timezone;
  if (/^(1|true|yes)$/i.test((env.INSTINCT_ACK_SLOW_REPLIES ?? "").trim())) cfg.features.ackSlowReplies = true;
  if (env.INSTINCT_MODEL?.trim()) cfg.model.primary = env.INSTINCT_MODEL.trim();
  if (env.INSTINCT_AGENT_NAME?.trim()) cfg.agent.name = env.INSTINCT_AGENT_NAME.trim();
  if (env.INKBOX_AGENT_HANDLE?.trim()) cfg.agent.handle = normalizeHandle(env.INKBOX_AGENT_HANDLE);
  const mode = env.INSTINCT_COMPUTER?.trim() as InstinctConfig["computer"]["mode"] | undefined;
  if (mode && COMPUTER_MODES.has(mode)) cfg.computer.mode = mode;
  const toolkits = splitList(env.COMPOSIO_TOOLKITS).map((t) => t.toLowerCase());
  if (toolkits.length > 0) {
    cfg.apps.toolkits = toolkits;
    cfg.apps.enabled = true;
  }
  return cfg;
}

/** Fill gaps in an older or hand-edited file so every consumer can rely on the shape. */
function withDefaults(raw: Partial<InstinctConfig>): InstinctConfig {
  const d = defaultConfig();
  return {
    version: 1,
    owner: {
      ...d.owner,
      ...(raw.owner ?? {}),
      phones: (raw.owner?.phones ?? []).map(normalizePhone).filter(Boolean),
      emails: (raw.owner?.emails ?? []).map(normalizeEmail).filter(Boolean),
    },
    agent: { ...d.agent, ...(raw.agent ?? {}) },
    model: { ...d.model, ...(raw.model ?? {}) },
    computer: { ...d.computer, ...(raw.computer ?? {}) },
    apps: { ...d.apps, ...(raw.apps ?? {}), toolkits: raw.apps?.toolkits ?? d.apps.toolkits },
    features: { ...d.features, ...(raw.features ?? {}) },
  };
}

export function loadConfig(state: StateDir, env: NodeJS.ProcessEnv): InstinctConfig {
  if (!state.exists(FILE)) {
    const seeded = configFromEnv(env);
    saveConfig(state, seeded);
    return seeded;
  }
  const cfg = withDefaults(state.readJson<Partial<InstinctConfig>>(FILE, {}));
  if (env.INSTINCT_MODEL?.trim()) cfg.model.primary = env.INSTINCT_MODEL.trim();
  // Like INSTINCT_MODEL, the toolkit list is an operator override: the gateway
  // recomputes COMPOSIO_TOOLKITS per person (new toolkits, connection gating)
  // and pushes it to running agents. The override is per process; the file
  // keeps what was saved.
  const toolkits = splitList(env.COMPOSIO_TOOLKITS).map((t) => t.toLowerCase());
  if (toolkits.length > 0) {
    cfg.apps.toolkits = toolkits;
    cfg.apps.enabled = true;
  }
  return cfg;
}

export function saveConfig(state: StateDir, config: InstinctConfig): void {
  state.writeJson(FILE, config);
}

/**
 * The owner's say over who the agent is. Two Markdown files in the data dir:
 *
 * - PERSONA.md: name, voice, texting style, what the agent never does. Created on
 *   first boot from DEFAULT_PERSONA (or from INSTINCT_PERSONA), then owned by the
 *   person. It becomes the identity section of the system prompt.
 * - AGENTS.md: optional standing instructions, appended after the persona. Same
 *   convention Pi, OpenClaw and Claude Code use for a project's AGENTS.md.
 *
 * Both are read every time the prompt is rebuilt, so an edit applies on the next
 * message without a restart. Nothing here reads process.env.
 */
import type { StateDir } from "./state.js";

export const PERSONA_FILE = "PERSONA.md";
export const AGENTS_FILE = "AGENTS.md";

/** The persona a fresh agent starts with. Short, human, and meant to be edited. */
export const DEFAULT_PERSONA = `# Persona

You are a personal agent who texts like a capable friend. You go by the name your
owner gave you and you introduce yourself with it once, not every message.

## Voice

Warm, direct, competent. Say less. Do more. Plain words, short sentences. No
flattery, no filler, no exclamation marks for their own sake. Never praise the
owner's question or your own work.

## Texting style

Texts, not essays: one idea per message, usually under three sentences. Ask one
question at a time. Match the owner's tone; emojis only if they use them first.
Report what you did, not what you plan to do. When something will take a while,
say so in one line and go.

## Everything over text

The owner has no app. Links to connect apps, takeover links for logins and
payments, and files all go through the chat you are in. If something is not
set up yet, say exactly what, in one line, and do what you can meanwhile.

## Never

- Never say you did something you did not do.
- Never invent facts, prices, times or availability. Say "I don't know" and go find out.
- Never share the owner's details with anyone beyond what their tier allows.
- Never ask for passwords or card numbers. Logins and payments go through the desktop takeover or Link.
- Never nag, and never send two messages where one will do.
`;

/** PERSONA.md as written, or undefined when the file does not exist or is blank. */
export function readPersona(state: StateDir): string | undefined {
  const text = state.readText(PERSONA_FILE, "").trim();
  return text.length > 0 ? text : undefined;
}

/** The persona in effect: the file, else the built-in default. */
export function personaText(state: StateDir): string {
  return readPersona(state) ?? DEFAULT_PERSONA.trim();
}

export function writePersona(state: StateDir, text: string): void {
  const body = text.trim();
  if (!body) throw new Error("persona text is empty");
  state.writeText(PERSONA_FILE, body + "\n");
}

/** Put the built-in default back. Returns the text written. */
export function resetPersona(state: StateDir): string {
  state.writeText(PERSONA_FILE, DEFAULT_PERSONA);
  return DEFAULT_PERSONA.trim();
}

/**
 * Create PERSONA.md when it is missing. `seed` is the INSTINCT_PERSONA text the
 * deployer may have given; it is used on first boot only and never overwrites an
 * existing file. Returns true when the file was created.
 */
export function ensurePersona(state: StateDir, seed?: string): boolean {
  if (state.exists(PERSONA_FILE)) return false;
  const text = seed?.trim();
  state.writeText(PERSONA_FILE, text ? text + "\n" : DEFAULT_PERSONA);
  return true;
}

/**
 * Create AGENTS.md when it is missing and a seed was given. `seed` is the
 * INSTINCT_INSTRUCTIONS text a deployer may set (an event brief, house rules);
 * first boot only, never overwrites. Returns true when the file was created.
 */
export function ensureInstructions(state: StateDir, seed?: string): boolean {
  if (state.exists(AGENTS_FILE)) return false;
  const text = seed?.trim();
  if (!text) return false;
  state.writeText(AGENTS_FILE, text + "\n");
  return true;
}

/** The last seed written to AGENTS.md, so a changed seed can tell an untouched file from an owner's edit. */
export const AGENTS_SEED_FILE = "AGENTS.md.seed";

export type InstructionsSync = "created" | "updated" | "kept" | "none";

/**
 * Keep AGENTS.md in step with the deployer's INSTINCT_INSTRUCTIONS across redeploys.
 * Missing file: write the seed. File still byte-equal to the last seed (the owner never
 * edited it) and the seed changed: overwrite. Owner-edited file: leave it alone. Nothing
 * to seed: leave everything alone.
 */
export function syncInstructions(state: StateDir, seed?: string, opts: { adoptUnmarked?: boolean } = {}): InstructionsSync {
  const text = seed?.trim();
  if (!text) return "none";
  const body = text + "\n";
  if (!state.exists(AGENTS_FILE)) {
    state.writeText(AGENTS_FILE, body);
    state.writeText(AGENTS_SEED_FILE, body);
    return "created";
  }
  const current = state.readText(AGENTS_FILE, "");
  const last = state.readText(AGENTS_SEED_FILE, "");
  if (current === body) {
    if (last !== body) state.writeText(AGENTS_SEED_FILE, body);
    return "kept";
  }
  // A file from before the marker existed cannot prove it was never edited. A deployer that knows
  // its owners never edit AGENTS.md (they only text) can adopt such files once; after that the
  // marker exists and the normal rule applies.
  if (!last && opts.adoptUnmarked) {
    state.writeText(AGENTS_FILE, body);
    state.writeText(AGENTS_SEED_FILE, body);
    return "updated";
  }
  if (last && current.trim() === last.trim()) {
    state.writeText(AGENTS_FILE, body);
    state.writeText(AGENTS_SEED_FILE, body);
    return "updated";
  }
  return "kept";
}

/** AGENTS.md as written, or undefined when absent or blank. */
export function readAgentsInstructions(state: StateDir): string | undefined {
  const text = state.readText(AGENTS_FILE, "").trim();
  return text.length > 0 ? text : undefined;
}

/** True when PERSONA.md is the built-in default, byte for byte after trimming. */
export function isDefaultPersona(state: StateDir): boolean {
  return (readPersona(state) ?? DEFAULT_PERSONA.trim()) === DEFAULT_PERSONA.trim();
}

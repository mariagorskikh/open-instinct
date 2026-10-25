import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENTS_FILE,
  DEFAULT_PERSONA,
  PERSONA_FILE,
  AGENTS_SEED_FILE,
  ensureInstructions,
  ensurePersona,
  syncInstructions,
  isDefaultPersona,
  personaText,
  readAgentsInstructions,
  readPersona,
  resetPersona,
  writePersona,
} from "../src/persona.js";
import { tempState } from "./helpers.js";

describe("persona files", () => {
  it("reads nothing until a file exists, then exactly what was written", () => {
    const state = tempState();
    expect(readPersona(state)).toBeUndefined();
    expect(personaText(state)).toBe(DEFAULT_PERSONA.trim());
    expect(isDefaultPersona(state)).toBe(true);

    writePersona(state, "  # Pip\n\nDry wit. Short sentences.\n\n");
    expect(fs.readFileSync(path.join(state.root, PERSONA_FILE), "utf8")).toBe("# Pip\n\nDry wit. Short sentences.\n");
    expect(readPersona(state)).toBe("# Pip\n\nDry wit. Short sentences.");
    expect(isDefaultPersona(state)).toBe(false);
    expect(() => writePersona(state, "   ")).toThrow(/empty/);
  });

  it("treats a blank file as absent", () => {
    const state = tempState();
    state.writeText(PERSONA_FILE, "\n\n");
    expect(readPersona(state)).toBeUndefined();
    expect(personaText(state)).toBe(DEFAULT_PERSONA.trim());
  });

  it("ensurePersona writes the default or the seed once and never overwrites", () => {
    const fresh = tempState();
    expect(ensurePersona(fresh)).toBe(true);
    expect(fs.readFileSync(path.join(fresh.root, PERSONA_FILE), "utf8")).toBe(DEFAULT_PERSONA);
    expect(ensurePersona(fresh, "Something else")).toBe(false);
    expect(readPersona(fresh)).toBe(DEFAULT_PERSONA.trim());

    const seeded = tempState();
    expect(ensurePersona(seeded, "  Terse. British. Never uses emojis.  ")).toBe(true);
    expect(readPersona(seeded)).toBe("Terse. British. Never uses emojis.");
    // A blank seed is no seed.
    const blank = tempState();
    ensurePersona(blank, "   ");
    expect(readPersona(blank)).toBe(DEFAULT_PERSONA.trim());
  });

  it("resetPersona restores the default over a custom file", () => {
    const state = tempState();
    writePersona(state, "Custom");
    expect(resetPersona(state)).toBe(DEFAULT_PERSONA.trim());
    expect(readPersona(state)).toBe(DEFAULT_PERSONA.trim());
    expect(isDefaultPersona(state)).toBe(true);
  });

  it("reads AGENTS.md when present and non-blank", () => {
    const state = tempState();
    expect(readAgentsInstructions(state)).toBeUndefined();
    state.writeText(AGENTS_FILE, "   ");
    expect(readAgentsInstructions(state)).toBeUndefined();
    state.writeText(AGENTS_FILE, "Always confirm restaurant bookings by text.\n");
    expect(readAgentsInstructions(state)).toBe("Always confirm restaurant bookings by text.");
  });

  it("the default persona is short, human and covers voice, texting and limits", () => {
    expect(DEFAULT_PERSONA.split("\n").length).toBeLessThan(40);
    for (const heading of ["## Voice", "## Texting style", "## Never"]) expect(DEFAULT_PERSONA).toContain(heading);
    expect(DEFAULT_PERSONA).not.toMatch(/—/); // no em-dashes, house style
  });
});

describe("ensureInstructions", () => {
  it("writes AGENTS.md from the seed once, never without a seed, never over an existing file", () => {
    const state = tempState();
    expect(ensureInstructions(state)).toBe(false);
    expect(ensureInstructions(state, "   ")).toBe(false);
    expect(state.exists(AGENTS_FILE)).toBe(false);

    expect(ensureInstructions(state, "  # Event\n\nYou are at a conference.  ")).toBe(true);
    expect(fs.readFileSync(path.join(state.root, AGENTS_FILE), "utf8")).toBe("# Event\n\nYou are at a conference.\n");
    expect(readAgentsInstructions(state)).toBe("# Event\n\nYou are at a conference.");

    expect(ensureInstructions(state, "# Something else")).toBe(false);
    expect(readAgentsInstructions(state)).toBe("# Event\n\nYou are at a conference.");
  });
});

describe("syncInstructions", () => {
  it("creates, updates an untouched file when the seed changes, and never overwrites an owner's edit", () => {
    const state = tempState();
    expect(syncInstructions(state)).toBe("none");
    expect(state.exists(AGENTS_FILE)).toBe(false);
    expect(syncInstructions(state, "# Event v1")).toBe("created");
    expect(readAgentsInstructions(state)).toBe("# Event v1");
    expect(state.readText(AGENTS_SEED_FILE, "")).toBe("# Event v1\n");
    expect(syncInstructions(state, "# Event v1")).toBe("kept");
    expect(syncInstructions(state, "# Event v2")).toBe("updated");
    expect(readAgentsInstructions(state)).toBe("# Event v2");
    state.writeText(AGENTS_FILE, "# Event v2\n\nMy own rule: no emojis.\n");
    expect(syncInstructions(state, "# Event v3")).toBe("kept");
    expect(readAgentsInstructions(state)).toBe("# Event v2\n\nMy own rule: no emojis.");
    expect(syncInstructions(state, "   ")).toBe("none");
  });

  it("adopts a file written by the older seed-once path as the baseline", () => {
    const state = tempState();
    expect(ensureInstructions(state, "# Old seed")).toBe(true);
    expect(state.exists(AGENTS_SEED_FILE)).toBe(false);
    // No marker yet: the file is treated as the owner's until the seed matches it once.
    expect(syncInstructions(state, "# New seed")).toBe("kept");
    expect(syncInstructions(state, "# Old seed")).toBe("kept");
    expect(state.readText(AGENTS_SEED_FILE, "")).toBe("# Old seed\n");
    expect(syncInstructions(state, "# New seed")).toBe("updated");
  });

  it("adopts an unmarked file at once when adoptUnmarked is set, then follows the normal rule", () => {
    const state = tempState();
    expect(ensureInstructions(state, "# Old seed")).toBe(true);
    expect(syncInstructions(state, "# New seed", { adoptUnmarked: true })).toBe("updated");
    expect(readAgentsInstructions(state)).toBe("# New seed");
    expect(state.readText(AGENTS_SEED_FILE, "")).toBe("# New seed\n");
    state.writeText(AGENTS_FILE, "# New seed\n\nMine.\n");
    expect(syncInstructions(state, "# Newer seed", { adoptUnmarked: true })).toBe("kept");
  });
});


import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_TOOLKITS, defaultConfig, loadConfig, saveConfig } from "../src/config.js";
import { tempState } from "./helpers.js";

describe("config", () => {
  it("has sane defaults", () => {
    const d = defaultConfig();
    expect(d.version).toBe(1);
    expect(d.model.primary).toBe(DEFAULT_MODEL);
    expect(d.model.fallback).toBe("anthropic/claude-opus-5-5");
    expect(d.computer.mode).toBe("auto");
    expect(d.apps).toEqual({ enabled: false, toolkits: DEFAULT_TOOLKITS });
    expect(d.owner.timezone.length).toBeGreaterThan(0);
  });

  it("seeds from env on first load and writes config.json", () => {
    const state = tempState();
    const env = {
      INSTINCT_OWNER_NAME: "Maria",
      INSTINCT_OWNER_PHONE: "(617) 555-0100, +1 617 555 0101",
      INSTINCT_OWNER_EMAIL: "Maria@Example.com",
      INSTINCT_OWNER_TIMEZONE: "America/New_York",
      INSTINCT_MODEL: "anthropic/claude-sonnet-5-5",
      INSTINCT_AGENT_NAME: "Pip",
      INKBOX_AGENT_HANDLE: "@Maria-Instinct",
      INSTINCT_COMPUTER: "maritime",
      COMPOSIO_TOOLKITS: "gmail,GoogleCalendar",
    };
    const cfg = loadConfig(state, env);
    expect(cfg.owner).toEqual({ name: "Maria", phones: ["+16175550100", "+16175550101"], emails: ["maria@example.com"], timezone: "America/New_York" });
    expect(cfg.model.primary).toBe("anthropic/claude-sonnet-5-5");
    expect(cfg.agent).toEqual({ name: "Pip", handle: "maria-instinct" });
    expect(cfg.computer.mode).toBe("maritime");
    expect(cfg.apps).toEqual({ enabled: true, toolkits: ["gmail", "googlecalendar"] });
    expect(state.exists("config.json")).toBe(true);
    expect(state.readJson("config.json", null)).toEqual(cfg);
  });

  it("accepts the older INSTINCT_TIMEZONE name, with INSTINCT_OWNER_TIMEZONE winning", () => {
    expect(loadConfig(tempState(), { INSTINCT_TIMEZONE: "Europe/Berlin" }).owner.timezone).toBe("Europe/Berlin");
    expect(loadConfig(tempState(), { INSTINCT_TIMEZONE: "Europe/Berlin", INSTINCT_OWNER_TIMEZONE: "Asia/Tokyo" }).owner.timezone).toBe("Asia/Tokyo");
  });

  it("seeds features.ackSlowReplies from INSTINCT_ACK_SLOW_REPLIES only when set", () => {
    expect(loadConfig(tempState(), {}).features.ackSlowReplies).toBeUndefined();
    expect(loadConfig(tempState(), { INSTINCT_ACK_SLOW_REPLIES: "0" }).features.ackSlowReplies).toBeUndefined();
    expect(loadConfig(tempState(), { INSTINCT_ACK_SLOW_REPLIES: "true" }).features.ackSlowReplies).toBe(true);
  });

  it("prefers the file over env on later loads, except INSTINCT_MODEL", () => {
    const state = tempState();
    loadConfig(state, { INSTINCT_OWNER_NAME: "Maria", INSTINCT_OWNER_PHONE: "+16175550100" });
    const again = loadConfig(state, { INSTINCT_OWNER_NAME: "Someone Else", INSTINCT_OWNER_PHONE: "+19999999999", INSTINCT_COMPUTER: "none" });
    expect(again.owner.name).toBe("Maria");
    expect(again.owner.phones).toEqual(["+16175550100"]);
    expect(again.computer.mode).toBe("auto");
    const swapped = loadConfig(state, { INSTINCT_MODEL: "openai-compatible/gpt-5" });
    expect(swapped.model.primary).toBe("openai-compatible/gpt-5");
    // The override is per process; the file keeps what was saved.
    expect(state.readJson<{ model: { primary: string } }>("config.json", { model: { primary: "" } }).model.primary).toBe(DEFAULT_MODEL);
    // The budget contact is an operator setting too: env wins on every boot, nothing is written.
    expect(loadConfig(state, { INSTINCT_BUDGET_CONTACT: " help@example.com " }).features.budgetContact).toBe("help@example.com");
    expect(loadConfig(state, {}).features.budgetContact).toBeUndefined();
  });

  it("seeds owner.claimOnFirstContact from INSTINCT_CLAIM_OWNER_ON_FIRST_CONTACT only when set", () => {
    const off = loadConfig(tempState(), { INSTINCT_OWNER_NAME: "Maria" });
    expect(off.owner.claimOnFirstContact).toBeUndefined();
    const on = loadConfig(tempState(), { INSTINCT_OWNER_NAME: "Maria", INSTINCT_CLAIM_OWNER_ON_FIRST_CONTACT: "1" });
    expect(on.owner.phones).toEqual([]);
    expect(on.owner.claimOnFirstContact).toBe(true);
    const no = loadConfig(tempState(), { INSTINCT_CLAIM_OWNER_ON_FIRST_CONTACT: "0" });
    expect(no.owner.claimOnFirstContact).toBeUndefined();
    const coded = loadConfig(tempState(), { INSTINCT_CLAIM_OWNER_ON_FIRST_CONTACT: "1", INSTINCT_OWNER_CLAIM_CODE: "  K7P2-QX9M  ", INSTINCT_OWNER_CLAIM_EXPIRES_AT: "2026-11-01T00:00:00Z" });
    expect(coded.owner.claimCode).toBe("K7P2-QX9M");
    expect(coded.owner.claimExpiresAt).toBe("2026-11-01T00:00:00Z");
    expect(on.owner.claimCode).toBeUndefined();
  });

  it("ignores an invalid computer mode and fills gaps in a hand-edited file", () => {
    const state = tempState();
    expect(loadConfig(state, { INSTINCT_COMPUTER: "quantum" }).computer.mode).toBe("auto");
    state.writeJson("config.json", { version: 1, owner: { name: "M", phones: ["617 555 0100"] } });
    const cfg = loadConfig(state, {});
    expect(cfg.owner.name).toBe("M");
    expect(cfg.owner.phones).toEqual(["+16175550100"]);
    expect(cfg.owner.emails).toEqual([]);
    expect(cfg.model.primary).toBe(DEFAULT_MODEL);
    expect(cfg.features.journal).toBe(true);
    expect(cfg.apps.toolkits).toEqual(DEFAULT_TOOLKITS);
  });

  it("saveConfig round-trips", () => {
    const state = tempState();
    const cfg = defaultConfig();
    cfg.owner.name = "Maria";
    cfg.features.tapbacks = false;
    saveConfig(state, cfg);
    expect(loadConfig(state, {})).toEqual(cfg);
  });
});

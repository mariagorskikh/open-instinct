import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractDataDir } from "../src/args.js";
import { table } from "../src/ansi.js";
import { decodeDataUrl } from "../src/commands/connect.js";
import { modelSpecFor } from "../src/commands/deploy.js";
import { appsWarning } from "../src/commands/dev.js";
import { applyInitFlags, parseInitFlags, splitToolkits } from "../src/commands/init.js";
import { buildAuthorizeUrl } from "../src/commands/payments.js";
import { defaultConfig } from "@open-instinct/core";
import { flattenStatus } from "../src/commands/status.js";
import { parseUntil, parseCapabilities } from "../src/commands/trust.js";
import { validateCron } from "../src/commands/schedules.js";
import { applySecretsToEnv, readSecrets, secretsToEnv, writeSecrets } from "../src/secrets.js";
import { resolveCliDataDir } from "../src/context.js";
import { tmpDir } from "./helpers.js";

describe("extractDataDir", () => {
  it("pulls --data-dir from anywhere in argv, in both spellings", () => {
    expect(extractDataDir(["trust", "list", "--data-dir", "/x"])).toEqual({ argv: ["trust", "list"], dataDir: "/x" });
    expect(extractDataDir(["--data-dir=/y", "init"])).toEqual({ argv: ["init"], dataDir: "/y" });
    expect(extractDataDir(["init"])).toEqual({ argv: ["init"], dataDir: undefined });
    // The command word is the first remaining argument, not argv[0]; bin.ts relies on this for `dev`.
    expect(extractDataDir(["--data-dir", "x", "dev"]).argv[0]).toBe("dev");
    expect(extractDataDir(["--data-dir=x", "dev", "--tunnel"]).argv).toEqual(["dev", "--tunnel"]);
  });
  it("fails when the flag has no value", () => {
    expect(() => extractDataDir(["init", "--data-dir"])).toThrow(/needs a path/);
  });
});

describe("resolveCliDataDir", () => {
  it("prefers the flag, then env, then ./.instinct", () => {
    expect(resolveCliDataDir({ INSTINCT_DATA_DIR: "/env" }, "/cwd", "/flag")).toBe("/flag");
    expect(resolveCliDataDir({ INSTINCT_DATA_DIR: "rel" }, "/cwd")).toBe("/cwd/rel");
    expect(resolveCliDataDir({}, "/cwd")).toBe("/cwd/.instinct");
  });
});

describe("secrets", () => {
  it("round-trips and keeps the file private", () => {
    const dir = tmpDir();
    const file = writeSecrets(dir, { handle: "h", identityId: "i", apiKey: "k", signingKey: "s", email: "h@inkboxmail.com" });
    expect(file).toBe(path.join(dir, "secrets", "inkbox.json"));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readSecrets(dir)?.apiKey).toBe("k");
    expect(secretsToEnv(readSecrets(dir)!)).toEqual({ INKBOX_API_KEY: "k", INKBOX_AGENT_HANDLE: "h", INKBOX_IDENTITY_ID: "i", INKBOX_SIGNING_KEY: "s" });
  });
  it("returns undefined for a missing or malformed file", () => {
    const dir = tmpDir();
    expect(readSecrets(dir)).toBeUndefined();
    fs.mkdirSync(path.join(dir, "secrets"));
    fs.writeFileSync(path.join(dir, "secrets", "inkbox.json"), "{not json");
    expect(readSecrets(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, "secrets", "inkbox.json"), JSON.stringify({ handle: "h" }));
    expect(readSecrets(dir)).toBeUndefined();
  });
  it("applySecretsToEnv never overrides existing values", () => {
    const env: NodeJS.ProcessEnv = { INKBOX_API_KEY: "mine" };
    const applied = applySecretsToEnv(env, { handle: "h", identityId: "i", apiKey: "k" });
    expect(applied.sort()).toEqual(["INKBOX_AGENT_HANDLE", "INKBOX_IDENTITY_ID"]);
    expect(env.INKBOX_API_KEY).toBe("mine");
    expect(applySecretsToEnv(env, undefined)).toEqual([]);
  });
});

describe("trust parsing", () => {
  it("parseUntil accepts a date (end of day UTC) or an ISO timestamp", () => {
    expect(parseUntil("2026-12-31", "trust")).toBe("2026-12-31T23:59:59.000Z");
    expect(parseUntil("2026-10-06T12:00:00-04:00", "trust")).toBe("2026-10-06T16:00:00.000Z");
    expect(parseUntil(undefined, "trust")).toBeUndefined();
    expect(() => parseUntil("next tuesday", "trust")).toThrow(/--until/);
  });
  it("parseCapabilities splits, trims and validates", () => {
    expect(parseCapabilities("calendar.write, plans.commit", "trust")).toEqual(["calendar.write", "plans.commit"]);
    expect(() => parseCapabilities("nope", "trust")).toThrow(/Unknown capability/);
    expect(() => parseCapabilities(" , ", "trust")).toThrow(/at least one/);
  });
});

describe("validateCron", () => {
  it("accepts numeric expressions and named days and months supported by core", () => {
    expect(() => validateCron("*/15 9-17 * * 1-5")).not.toThrow();
    expect(() => validateCron("0 8,20 1 * *")).not.toThrow();
    expect(() => validateCron("0 9 * * mon-fri")).not.toThrow();
    expect(() => validateCron("0 9 * jan *")).not.toThrow();
  });
  it("rejects malformed expressions", () => {
    expect(() => validateCron("0 8 * *")).toThrow(/5 fields/);
    expect(() => validateCron("60 8 * * *")).toThrow(/out of range/);
    expect(() => validateCron("0 8 * * nonsense")).toThrow(/bad value/);
  });
});

describe("decodeDataUrl", () => {
  it("decodes base64 PNG data URLs", () => {
    const d = decodeDataUrl("data:image/png;base64,iVBORw0KGgo=");
    expect(d?.mimeType).toBe("image/png");
    expect(d?.bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  it("returns undefined for non data URLs", () => {
    expect(decodeDataUrl("https://example.com/qr.png")).toBeUndefined();
  });
});

describe("init flags", () => {
  it("splitToolkits lowercases, trims and drops empties", () => {
    expect(splitToolkits("Gmail, GoogleCalendar;slack")).toEqual(["gmail", "googlecalendar", "slack"]);
    expect(splitToolkits(" , ")).toBeUndefined();
    expect(splitToolkits(undefined)).toBeUndefined();
  });
  it("derives apps from flags first, then env, and applies them on top of an existing config", () => {
    expect(parseInitFlags(["--name", "M"]).apps).toBeUndefined();
    expect(parseInitFlags(["--name", "M"], { COMPOSIO_API_KEY: "k" })).toMatchObject({ apps: true, toolkits: undefined });
    expect(parseInitFlags(["--name", "M"], { COMPOSIO_TOOLKITS: "gmail" })).toMatchObject({ apps: true, toolkits: ["gmail"] });
    expect(parseInitFlags(["--name", "M", "--toolkits", "slack"], { COMPOSIO_TOOLKITS: "gmail" }).toolkits).toEqual(["slack"]);
    expect(parseInitFlags(["--name", "M", "--no-apps"], { COMPOSIO_API_KEY: "k", COMPOSIO_TOOLKITS: "gmail" })).toMatchObject({ apps: false, toolkits: undefined });
    expect(() => parseInitFlags(["--name", "M", "--apps", "--no-apps"])).toThrow(/cannot both/);

    const base = defaultConfig();
    const on = applyInitFlags(base, { name: "M", phoneNumber: false, skipInkbox: false, apps: true, toolkits: ["slack"] });
    expect(on.apps).toEqual({ enabled: true, toolkits: ["slack"] });
    const untouched = applyInitFlags(on, { name: "M", phoneNumber: false, skipInkbox: false });
    expect(untouched.apps).toEqual({ enabled: true, toolkits: ["slack"] });
    expect(applyInitFlags(on, { name: "M", phoneNumber: false, skipInkbox: false, apps: false }).apps).toEqual({ enabled: false, toolkits: ["slack"] });
  });
});

describe("appsWarning", () => {
  it("fires only when a key is present and apps are off", () => {
    expect(appsWarning({ COMPOSIO_API_KEY: "k" }, false)).toMatch(/--apps/);
    expect(appsWarning({ COMPOSIO_API_KEY: "k" }, true)).toBeUndefined();
    expect(appsWarning({}, false)).toBeUndefined();
  });
});

describe("modelSpecFor", () => {
  it("prefers the flag, then INSTINCT_MARITIME_MODEL, then the default; config otherwise", () => {
    const config = { ...defaultConfig(), model: { ...defaultConfig().model, primary: "anthropic/x" } };
    expect(modelSpecFor({ maritimeLlm: true, config, env: {} })).toBe("openai-compatible/gpt-5.4");
    expect(modelSpecFor({ maritimeLlm: true, config, env: { INSTINCT_MARITIME_MODEL: "gpt-5" } })).toBe("openai-compatible/gpt-5");
    expect(modelSpecFor({ maritimeLlm: true, model: "gpt-5.5", config, env: { INSTINCT_MARITIME_MODEL: "gpt-5" } })).toBe("openai-compatible/gpt-5.5");
    expect(modelSpecFor({ maritimeLlm: true, model: "openai-compatible/custom", config, env: {} })).toBe("openai-compatible/custom");
    expect(modelSpecFor({ config, env: {} })).toBe("anthropic/x");
    expect(modelSpecFor({ model: "anthropic/y", config, env: {} })).toBe("anthropic/y");
  });
});

describe("buildAuthorizeUrl", () => {
  it("builds the Link OAuth URL with a default redirect on the local server", () => {
    const u = new URL(buildAuthorizeUrl({ LINK_CLIENT_ID: "lc" }, "http://127.0.0.1:8080/", "st"));
    expect(u.origin + u.pathname).toBe("https://login.link.com/auth");
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8080/oauth/link/callback");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("scope")).toBe("payment_methods.agentic");
    expect(() => buildAuthorizeUrl({}, "http://127.0.0.1:8080")).toThrow(/LINK_CLIENT_ID/);
  });
});

describe("output helpers", () => {
  it("flattenStatus flattens one level and stringifies the rest", () => {
    expect(flattenStatus({ a: 1, owner: { name: "M", phones: ["+1"] }, deep: { x: { y: 1 } } })).toEqual([
      ["a", "1"],
      ["owner.name", "M"],
      ["owner.phones", "+1"],
      ["deep.x", '{"y":1}'],
    ]);
  });
  it("table pads columns", () => {
    expect(table([["a", "bb"], ["ccc", "d"]], "")).toBe("a    bb\nccc  d");
  });
});

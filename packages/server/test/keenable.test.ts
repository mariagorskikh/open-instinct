import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { boot } from "../src/boot.js";

const KEY = "keenable_test_key_0123456789";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Boots an agent and returns the tool count from its "ready" line, plus every log line. */
async function bootWith(extra: NodeJS.ProcessEnv): Promise<{ tools: number; logs: string[] }> {
  const dataDir = mkdtempSync(join(tmpdir(), "instinct-boot-"));
  dirs.push(dataDir);
  const env: NodeJS.ProcessEnv = {
    INSTINCT_DATA_DIR: dataDir,
    INSTINCT_OWNER_NAME: "Test Owner",
    INSTINCT_OWNER_PHONE: "+14155550100",
    INSTINCT_AGENT_NAME: "Test",
    INSTINCT_MODEL: "faux/faux-1",
    INSTINCT_COMPUTER: "none",
    INSTINCT_SKILLS_DIR: join(dataDir, "no-skills"),
    ...extra,
  };
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const streamFn = models.streamSimple.bind(models) as unknown as StreamFn;
  const logs: string[] = [];
  const fetchImpl = (async () => new Response("not found", { status: 404 })) as typeof fetch;
  const app = await boot(env, { model: faux.getModel("faux-1"), streamFn, logger: (m) => logs.push(m), fetchImpl });
  await app.close();
  const ready = logs.map((l) => /ready: .*, (\d+) tools,/.exec(l)).find(Boolean);
  if (!ready) throw new Error(`no ready line in ${JSON.stringify(logs)}`);
  return { tools: Number(ready[1]), logs };
}

describe("Keenable wiring in boot", () => {
  it("adds its two tools only with KEENABLE_SEARCH=1 or a key, and never logs the key", async () => {
    const base = (await bootWith({})).tools;
    expect((await bootWith({ KEENABLE_SEARCH: "0" })).tools).toBe(base);
    expect((await bootWith({ KEENABLE_SEARCH: "1" })).tools).toBe(base + 2);
    // The same values the gateway accepts, since `instinct deploy` forwards the switch as written.
    expect((await bootWith({ KEENABLE_SEARCH: "true" })).tools).toBe(base + 2);
    expect((await bootWith({ KEENABLE_SEARCH: "Yes" })).tools).toBe(base + 2);
    expect((await bootWith({ KEENABLE_SEARCH: "false" })).tools).toBe(base);
    const keyed = await bootWith({ KEENABLE_API_KEY: KEY });
    expect(keyed.tools).toBe(base + 2);
    for (const line of keyed.logs) expect(line).not.toContain(KEY);
  });
});

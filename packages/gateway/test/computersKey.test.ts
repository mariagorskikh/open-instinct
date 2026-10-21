import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPUTERS_KEY_NAME, ensureComputersKey } from "../src/computersKey.js";
import { tempDir } from "./helpers.js";

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

/** Maritime keys API mock: GET lists, POST mints. */
function keysFetch(opts: { list?: () => Response; mint: () => Response }): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (method === "POST" && url.endsWith("/api/v1/keys")) return opts.mint();
    return opts.list ? opts.list() : Response.json({ detail: "not found" }, { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("ensureComputersKey", () => {
  it("lets an operator override win without calling Maritime at all", async () => {
    const { calls, fetchImpl } = keysFetch({ mint: () => Response.json({}) });
    const key = await ensureComputersKey({ apiKey: "mk_fleet", dataDir: tempDir(), override: " mk_operator ", fetchImpl });
    expect(key).toBe("mk_operator");
    expect(calls).toHaveLength(0);
  });

  it("mints a computers-scoped key once and reuses the stored one on later boots", async () => {
    const dataDir = tempDir();
    const first = keysFetch({
      mint: () => Response.json({ id: "key_1", raw_key: "mk_narrow", is_active: true, scopes: ["computers"] }),
      list: () => Response.json([]),
    });
    const key = await ensureComputersKey({ apiKey: "mk_fleet", dataDir, fetchImpl: first.fetchImpl });
    expect(key).toBe("mk_narrow");
    const mint = first.calls.find((c) => c.method === "POST");
    expect(mint?.body).toEqual({ name: COMPUTERS_KEY_NAME, scopes: ["computers"] });
    const file = join(dataDir, "computers-key.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ id: "key_1", key: "mk_narrow" });

    const second = keysFetch({
      list: () => Response.json([{ id: "key_1", is_active: true, scopes: ["computers"] }]),
      mint: () => Response.json({ id: "key_2", raw_key: "mk_dup" }),
    });
    const again = await ensureComputersKey({ apiKey: "mk_fleet", dataDir, fetchImpl: second.fetchImpl });
    expect(again).toBe("mk_narrow");
    expect(second.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("keeps using the stored key when the list call fails", async () => {
    const dataDir = tempDir();
    const first = keysFetch({ mint: () => Response.json({ id: "key_1", raw_key: "mk_narrow" }) });
    await ensureComputersKey({ apiKey: "mk_fleet", dataDir, fetchImpl: first.fetchImpl });

    const flaky = keysFetch({ list: () => Response.json({ detail: "boom" }, { status: 500 }), mint: () => Response.json({}) });
    const key = await ensureComputersKey({ apiKey: "mk_fleet", dataDir, fetchImpl: flaky.fetchImpl });
    expect(key).toBe("mk_narrow");
    expect(flaky.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("mints again when the stored key was deleted or disabled", async () => {
    const dataDir = tempDir();
    const first = keysFetch({ mint: () => Response.json({ id: "key_1", raw_key: "mk_old" }) });
    await ensureComputersKey({ apiKey: "mk_fleet", dataDir, fetchImpl: first.fetchImpl });

    const second = keysFetch({
      list: () => Response.json([{ id: "key_1", is_active: false }]),
      mint: () => Response.json({ id: "key_2", raw_key: "mk_new" }),
    });
    const key = await ensureComputersKey({ apiKey: "mk_fleet", dataDir, fetchImpl: second.fetchImpl });
    expect(key).toBe("mk_new");
    expect(JSON.parse(readFileSync(join(dataDir, "computers-key.json"), "utf8"))).toMatchObject({ id: "key_2", key: "mk_new" });
  });

  it("returns undefined on mint failure instead of throwing", async () => {
    const failing = keysFetch({ mint: () => Response.json({ detail: "quota" }, { status: 403 }), list: () => Response.json([]) });
    const key = await ensureComputersKey({ apiKey: "mk_fleet", dataDir: tempDir(), fetchImpl: failing.fetchImpl });
    expect(key).toBeUndefined();

    const malformed = keysFetch({ mint: () => Response.json({ id: "key_1" }), list: () => Response.json([]) });
    expect(await ensureComputersKey({ apiKey: "mk_fleet", dataDir: tempDir(), fetchImpl: malformed.fetchImpl })).toBeUndefined();
  });
});

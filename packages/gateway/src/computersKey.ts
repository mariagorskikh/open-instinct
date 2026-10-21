import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "./logger.js";

/** Name of the narrow, computers-scoped API key this gateway mints for agents. */
export const COMPUTERS_KEY_NAME = "instinct-computers";
/** The only scope mcp.maritime.sh accepts besides manage/full access (probed 2026-10). */
export const COMPUTERS_SCOPE = "computers";

export interface ComputersKeyOptions {
  /** The fleet key (full access): the only credential allowed to mint the narrow key. */
  apiKey: string;
  baseUrl?: string;
  dataDir: string;
  /** MARITIME_COMPUTERS_API_KEY: an operator-minted key that wins over minting our own. */
  override?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

interface StoredKey {
  id: string;
  key: string;
}

interface MintedKey {
  id?: string;
  raw_key?: string;
  is_active?: boolean;
}

function readStored(file: string): StoredKey | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as StoredKey;
    if (typeof parsed?.id === "string" && typeof parsed?.key === "string" && parsed.key) return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

function writeStored(file: string, value: StoredKey): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

/**
 * Resolve the key agents get as their own `MARITIME_API_KEY`, so the fleet key
 * never reaches an agent.
 *
 * Ladder (probed against mcp.maritime.sh): end-user tokens and deploy-scoped
 * keys are rejected there; a project key minted with `scopes:["computers"]`
 * works. The gateway mints that key once with the fleet key and persists it in
 * the data dir (0600); an operator-provided override always wins. Any failure
 * means "no hosted computer", never a boot failure — the in-VM desktop and the
 * no-computer fallback stay in place.
 */
export async function ensureComputersKey(opts: ComputersKeyOptions): Promise<string | undefined> {
  const log = opts.logger;
  const override = opts.override?.trim();
  if (override) return override;
  const f = opts.fetchImpl ?? globalThis.fetch;
  const base = (opts.baseUrl ?? "https://api.maritime.sh").replace(/\/+$/, "");
  const file = join(opts.dataDir, "computers-key.json");
  const headers = { Authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json", accept: "application/json" };

  try {
    const stored = readStored(file);
    if (stored) {
      // The stored key is reused while its id still exists and is active; a
      // deleted or disabled key is minted again under the same name.
      try {
        const res = await f(`${base}/api/v1/keys`, { headers });
        if (res.ok) {
          const parsed: unknown = await res.json();
          const items = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { items?: unknown })?.items) ? (parsed as { items: unknown[] }).items : [];
          const match = (items as MintedKey[]).find((k) => k.id === stored.id);
          if (match && match.is_active !== false) return stored.key;
        } else {
          // Listing failed (network/5xx): keep using what we have rather than minting duplicates.
          log?.warn("computers_key.list_failed", { status: res.status, using: "stored" });
          return stored.key;
        }
      } catch (err) {
        log?.warn("computers_key.list_failed", { error: err instanceof Error ? err.message : String(err), using: "stored" });
        return stored.key;
      }
    }

    const res = await f(`${base}/api/v1/keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: COMPUTERS_KEY_NAME, scopes: [COMPUTERS_SCOPE] }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`mint ${res.status}: ${text.slice(0, 200)}`);
    const minted = JSON.parse(text) as MintedKey;
    if (!minted.raw_key) throw new Error("mint returned no raw_key");
    if (minted.id) writeStored(file, { id: minted.id, key: minted.raw_key });
    log?.info("computers_key.minted", { name: COMPUTERS_KEY_NAME, id: minted.id });
    return minted.raw_key;
  } catch (err) {
    log?.warn("computers_key.failed", {
      error: err instanceof Error ? err.message : String(err),
      effect: "agents run without a hosted computer",
    });
    return undefined;
  }
}

import { type Logger, silentLogger } from "./logger.js";

/** The project-owned custom toolkit that fronts the self-hosted executor MCP server. */
export const EXECUTOR_TOOLKIT_SLUG = "CUSTOM_EXECUTOR";
/** Lowercased form the agent normalizes toolkits to; what templates list in COMPOSIO_TOOLKITS. */
export const EXECUTOR_TOOLKIT_NAME = "custom_executor";
export const DEFAULT_COMPOSIO_BASE_URL = "https://backend.composio.dev";
/** Session user id the gateway's own bootstrap connected account lives under. Agent sessions use the person's handle. */
export const GATEWAY_COMPOSIO_USER = "instinct-gateway";

export interface ExecutorConfig {
  /** COMPOSIO_API_KEY for this project. */
  apiKey: string;
  /** EXECUTOR_MCP_URL: the executor's MCP endpoint (app_url the toolkit registers). */
  appUrl: string;
  /** EXECUTOR_MCP_TOKEN: sent as the toolkit's generic_api_key credential (Bearer on every executor call). */
  token: string;
  /** COMPOSIO_BASE_URL override for tests. */
  baseUrl?: string;
}

export class ComposioApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ComposioApiError";
  }
}

function detailOf(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const d = j["detail"] ?? j["error"] ?? j["message"];
    if (typeof d === "string") return d;
    if (d !== undefined) return JSON.stringify(d);
  } catch {
    // not json
  }
  return text.slice(0, 300) || "no detail";
}

interface ListEnvelope {
  items?: Array<Record<string, unknown>>;
}

/**
 * The project-level Composio state the gateway keeps on behalf of every agent:
 * the executor custom toolkit, its API-key auth config, a bootstrap connected
 * account (used to sync tool definitions at boot), and per-user connected
 * accounts created at provision time.
 *
 * Every call is idempotent: boots repeat them, and a repeat must not create a
 * second toolkit or account.
 */
export class ComposioPlatform {
  private readonly cfg: ExecutorConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private authConfigId: string | undefined;

  constructor(cfg: ExecutorConfig, deps: { fetchImpl?: typeof fetch; logger?: Logger } = {}) {
    this.cfg = cfg;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.log = deps.logger ?? silentLogger;
  }

  private async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const base = (this.cfg.baseUrl ?? DEFAULT_COMPOSIO_BASE_URL).replace(/\/+$/, "");
    const res = await this.fetchImpl(`${base}${path}`, {
      method,
      headers: {
        "x-api-key": this.cfg.apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new ComposioApiError(res.status, `${method} ${path}: ${detailOf(text)}`);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined as T;
    }
  }

  /**
   * Boot sequence: register the toolkit, resolve its auth config, connect the
   * gateway's own account, then sync tool definitions from the executor MCP.
   * Called once before the gateway starts accepting signups; every step logs
   * and rethrows so the caller can decide (a missing executor must not stop
   * the gateway, but it must be loud).
   */
  async ensureBoot(): Promise<void> {
    await this.ensureToolkit();
    const authConfigId = await this.ensureAuthConfig();
    const account = await this.ensureAccount(GATEWAY_COMPOSIO_USER, authConfigId);
    await this.sync(account);
    this.log.info("composio.executor_ready", { toolkit: EXECUTOR_TOOLKIT_SLUG, appUrl: this.cfg.appUrl });
  }

  /**
   * Create or refresh the toolkit registration. `app_url` and `auth_schemes`
   * are immutable on an existing toolkit (409): that surfaces as an error the
   * boot log carries, because syncing against the wrong URL would quietly keep
   * serving stale tools.
   */
  async ensureToolkit(): Promise<void> {
    await this.request("POST", "/api/v3.1/custom/toolkits/upsert", {
      slug: EXECUTOR_TOOLKIT_SLUG,
      toolkit_config: {
        name: "Executor",
        app_url: this.cfg.appUrl,
        auth_schemes: [{ mode: "API_KEY", headers: { Authorization: "Bearer {{generic_api_key}}" } }],
      },
    });
  }

  /** The toolkit's own API-key auth config: list first (a boot must not duplicate), create otherwise. */
  async ensureAuthConfig(): Promise<string> {
    if (this.authConfigId) return this.authConfigId;
    const list = await this.request<ListEnvelope>(
      "GET",
      `/api/v3.1/auth_configs?toolkit_slug=${encodeURIComponent(EXECUTOR_TOOLKIT_SLUG)}&limit=50`,
    );
    const found = (list.items ?? []).find((item) => {
      const scheme = String(item["auth_scheme"] ?? item["authScheme"] ?? "");
      const managed = item["is_composio_managed"] ?? item["isComposioManaged"];
      return scheme === "API_KEY" && managed !== true;
    });
    const foundId = found ? String(found["id"] ?? "") : "";
    if (foundId) {
      this.authConfigId = foundId;
      return foundId;
    }
    const created = await this.request<Record<string, unknown>>("POST", "/api/v3.1/auth_configs", {
      toolkit: { slug: EXECUTOR_TOOLKIT_SLUG },
      auth_config: {
        type: "use_custom_auth",
        name: "Executor token",
        authScheme: "API_KEY",
        credentials: { generic_api_key: this.cfg.token },
        is_enabled_for_tool_router: true,
      },
    });
    const nested = created["auth_config"] as { id?: string } | undefined;
    const id = String(created["id"] ?? nested?.id ?? "");
    if (!id) throw new ComposioApiError(500, "auth config create returned no id");
    this.authConfigId = id;
    return id;
  }

  /**
   * Connect one session user (an agent's Inkbox handle) to the executor. The
   * connection carries the token as its state, so agent sessions resolve it by
   * `user_id` without any pinning.
   */
  async ensureAccount(userId: string, authConfigId?: string): Promise<string> {
    const ac = authConfigId ?? (await this.ensureAuthConfig());
    const created = await this.request<Record<string, unknown>>("POST", "/api/v3.1/connected_accounts", {
      toolkit: EXECUTOR_TOOLKIT_SLUG,
      user_id: userId,
      auth_config: { id: ac },
      connection: {
        user_id: userId,
        state: { authScheme: "API_KEY", val: { generic_api_key: this.cfg.token } },
      },
    });
    const nested = created["connected_account"] as { id?: string } | undefined;
    const id = String(created["id"] ?? nested?.id ?? "");
    if (!id) throw new ComposioApiError(500, "connected account create returned no id");
    const status = typeof created["status"] === "string" ? created["status"] : "";
    if (status && status !== "ACTIVE") {
      this.log.warn("composio.account_not_active", { userId, status });
    }
    return id;
  }

  /** True while a stored connected-account id still resolves and is active. Used before reusing one. */
  async accountActive(id: string): Promise<boolean> {
    try {
      const acc = await this.request<Record<string, unknown>>("GET", `/api/v3.1/connected_accounts/${encodeURIComponent(id)}`);
      const status = String(acc["status"] ?? "ACTIVE");
      return status === "ACTIVE";
    } catch {
      return false;
    }
  }

  /** Re-fetch tool definitions from the executor MCP through the given account. */
  async sync(connectedAccountId: string): Promise<void> {
    const out = await this.request<Record<string, unknown>>("POST", "/api/v3.1/custom/toolkits/sync", {
      slug: EXECUTOR_TOOLKIT_SLUG,
      connected_account_id: connectedAccountId,
    });
    this.log.info("composio.executor_synced", {
      syncedCount: out["synced_count"] ?? out["syncedCount"],
      version: out["version"],
    });
  }
}

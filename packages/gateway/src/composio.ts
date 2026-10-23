import { type Logger, silentLogger } from "./logger.js";

/** The project-owned custom toolkit that fronts the self-hosted executor MCP server. */
export const EXECUTOR_TOOLKIT_SLUG = "CUSTOM_EXECUTOR";
/** Lowercased form the agent normalizes toolkits to; what templates list in COMPOSIO_TOOLKITS. */
export const EXECUTOR_TOOLKIT_NAME = "custom_executor";
/** Oxygen: custom toolkit with per-user DCR OAuth (Clerk-backed; no credentials at boot). */
export const OXYGEN_TOOLKIT_SLUG = "CUSTOM_OXYGEN";
export const OXYGEN_TOOLKIT_NAME = "custom_oxygen";
export const OXYGEN_MCP_URL = "https://oxygen-agent.com/mcp";
export const OXYGEN_DISCOVERY_URL = "https://oxygen-agent.com/.well-known/oauth-authorization-server";
/** Linear: a Composio-managed toolkit. Nothing to register at boot; each person connects their own account. */
export const LINEAR_TOOLKIT_NAME = "linear";
/** Postiz: custom toolkit over an MCP wrapper around the self-hosted Postiz public API. */
export const POSTIZ_TOOLKIT_SLUG = "CUSTOM_POSTIZ";
export const POSTIZ_TOOLKIT_NAME = "custom_postiz";
export const DEFAULT_COMPOSIO_BASE_URL = "https://backend.composio.dev";
/** Session user id the gateway's own bootstrap connected account lives under. Agent sessions use the person's handle. */
export const GATEWAY_COMPOSIO_USER = "instinct-gateway";

export interface ExecutorConfig {
  /** COMPOSIO_API_KEY for this project. */
  apiKey: string;
  /** EXECUTOR_MCP_URL: the executor's MCP endpoint (app_url the toolkit registers). Absent skips the executor. */
  appUrl?: string;
  /** EXECUTOR_MCP_TOKEN: sent as the toolkit's generic_api_key credential (Bearer on every executor call). */
  token?: string;
  /** COMPOSIO_BASE_URL override for tests. */
  baseUrl?: string;
  /** CUSTOM_POSTIZ app_url (the MCP wrapper). Absent skips the Postiz toolkit. */
  postizAppUrl?: string;
  /** false skips the Oxygen DCR toolkit at boot (tests). Default true. */
  oxygen?: boolean;
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

export interface EnsureAccountOptions {
  /** Toolkit slug; default EXECUTOR_TOOLKIT_SLUG. */
  toolkit?: string;
  /** generic_api_key carried by the connection; default the executor fleet token. */
  apiKey?: string;
  /** Skip the auth-config lookup when the caller already has one. */
  authConfigId?: string;
}

/**
 * The project-level Composio state the gateway keeps on behalf of every agent:
 * the executor custom toolkit (API-key, fleet token), the Oxygen custom toolkit
 * (per-user DCR OAuth), the Postiz custom toolkit (per-user BYOK key), and per-
 * user connected accounts created at provision time. Linear is Composio-managed
 * and needs nothing at boot.
 *
 * Each toolkit boots independently and records a readiness flag: one toolkit
 * failing must not take the others down, and the gateway strips a toolkit from
 * agent env lists whose flag never turned on.
 *
 * Every call is idempotent: boots repeat them, and a repeat must not create a
 * second toolkit or account.
 */
export class ComposioPlatform {
  private readonly cfg: ExecutorConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly authConfigIds = new Map<string, string>();

  executorReady = false;
  oxygenReady = false;
  postizReady = false;

  constructor(cfg: ExecutorConfig, deps: { fetchImpl?: typeof fetch; logger?: Logger } = {}) {
    this.cfg = cfg;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.log = deps.logger ?? silentLogger;
  }

  /** True when at least one custom toolkit finished booting; the platform is worth keeping. */
  get anyReady(): boolean {
    return this.executorReady || this.oxygenReady || this.postizReady;
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
   * Boot sequence: each configured toolkit registers independently — executor
   * (upsert, auth config, bootstrap account, sync), Oxygen (upsert, DCR auth
   * config), Postiz (upsert, auth config). Called once before the gateway
   * accepts signups. Failures are logged per toolkit and never throw: the
   * readiness flags tell the caller what survived.
   */
  async ensureBoot(): Promise<void> {
    if (this.cfg.appUrl && this.cfg.token) {
      try {
        await this.ensureToolkit();
        const authConfigId = await this.ensureAuthConfig();
        const account = await this.ensureAccount(GATEWAY_COMPOSIO_USER, { authConfigId });
        await this.sync(account);
        this.executorReady = true;
        this.log.info("composio.executor_ready", { toolkit: EXECUTOR_TOOLKIT_SLUG, appUrl: this.cfg.appUrl });
      } catch (err) {
        this.log.error("composio.executor_unavailable", {
          error: err instanceof Error ? err.message : String(err),
          effect: "agents run without the executor (custom_executor stripped from their toolkit list)",
        });
      }
    } else {
      this.log.warn("composio.executor_disabled", {
        reason: "EXECUTOR_MCP_URL and EXECUTOR_MCP_TOKEN must both be set",
      });
    }
    if (this.cfg.oxygen !== false) {
      try {
        await this.ensureOxygenToolkit();
        await this.ensureDcrAuthConfig(OXYGEN_TOOLKIT_SLUG, "Oxygen");
        this.oxygenReady = true;
        this.log.info("composio.oxygen_ready", { toolkit: OXYGEN_TOOLKIT_SLUG });
      } catch (err) {
        this.log.warn("composio.oxygen_unavailable", {
          error: err instanceof Error ? err.message : String(err),
          effect: "custom_oxygen stripped from their toolkit list",
        });
      }
    }
    if (this.cfg.postizAppUrl) {
      try {
        await this.ensurePostizToolkit();
        this.postizReady = true;
        this.log.info("composio.postiz_ready", { toolkit: POSTIZ_TOOLKIT_SLUG, appUrl: this.cfg.postizAppUrl });
      } catch (err) {
        this.log.warn("composio.postiz_unavailable", {
          error: err instanceof Error ? err.message : String(err),
          effect: "custom_postiz stripped from their toolkit list",
        });
      }
    }
  }

  /**
   * Create or refresh the toolkit registration. `app_url` and `auth_schemes`
   * are immutable on an existing toolkit (409): that surfaces as an error the
   * boot log carries, because syncing against the wrong URL would quietly keep
   * serving stale tools.
   */
  async ensureToolkit(): Promise<void> {
    if (!this.cfg.appUrl || !this.cfg.token) throw new ComposioApiError(500, "executor is not configured");
    await this.ensureCustomToolkit(EXECUTOR_TOOLKIT_SLUG, "Executor", this.cfg.appUrl, [
      { mode: "API_KEY", headers: { Authorization: "Bearer {{generic_api_key}}" } },
    ]);
  }

  async ensureOxygenToolkit(): Promise<void> {
    // Same bare-name rule as Postiz: the upsert endpoint prefixes "CUSTOM_"
    // itself, so sending OXYGEN_TOOLKIT_SLUG would register the unreachable
    // "CUSTOM_CUSTOM_OXYGEN". Send the name; the toolkit lands as "custom_oxygen".
    await this.ensureCustomToolkit(OXYGEN_TOOLKIT_SLUG.replace(/^CUSTOM_/i, ""), "Oxygen", OXYGEN_MCP_URL, [
      { mode: "DCR_OAUTH", discovery_url: OXYGEN_DISCOVERY_URL },
    ]);
  }

  async ensurePostizToolkit(): Promise<void> {
    const appUrl = this.cfg.postizAppUrl;
    if (!appUrl) throw new ComposioApiError(500, "postiz is not configured");
    // The upsert endpoint prefixes custom slugs with "CUSTOM_" itself: sending
    // POSTIZ_TOOLKIT_SLUG ("CUSTOM_POSTIZ") would register "CUSTOM_CUSTOM_POSTIZ",
    // which neither auth-config creation nor the agent's tool router can find.
    // Send the bare name so the toolkit lands as "custom_postiz". (The executor
    // and Oxygen upserts keep their prefixed slugs untouched: the executor lives
    // on a pre-existing "custom_executor" toolkit that must not be re-upserted.)
    await this.ensureCustomToolkit(POSTIZ_TOOLKIT_SLUG.replace(/^CUSTOM_/i, ""), "Postiz", appUrl, [
      { mode: "API_KEY", headers: { Authorization: "Bearer {{generic_api_key}}" } },
    ]);
  }

  private async ensureCustomToolkit(slug: string, name: string, appUrl: string, authSchemes: Array<Record<string, unknown>>): Promise<void> {
    await this.request("POST", "/api/v3.1/custom/toolkits/upsert", {
      slug,
      toolkit_config: {
        name,
        app_url: appUrl,
        auth_schemes: authSchemes,
      },
    });
  }

  /** The executor toolkit's own API-key auth config: list first (a boot must not duplicate), create otherwise. */
  async ensureAuthConfig(): Promise<string> {
    if (!this.cfg.token) throw new ComposioApiError(500, "executor is not configured");
    return this.ensureApiKeyAuthConfig(EXECUTOR_TOOLKIT_SLUG, "Executor token", this.cfg.token);
  }

  /**
   * An API-key auth config for a custom toolkit. The template key is only a
   * placeholder for the config itself — each connected account carries its own
   * key in its connection state, which is how BYOK toolkits stay per-person.
   */
  private async ensureApiKeyAuthConfig(slug: string, name: string, templateKey: string): Promise<string> {
    const cached = this.authConfigIds.get(slug);
    if (cached) return cached;
    const list = await this.request<ListEnvelope>(
      "GET",
      `/api/v3.1/auth_configs?toolkit_slug=${encodeURIComponent(slug)}&limit=50`,
    );
    const found = (list.items ?? []).find((item) => {
      const scheme = String(item["auth_scheme"] ?? item["authScheme"] ?? "");
      const managed = item["is_composio_managed"] ?? item["isComposioManaged"];
      return scheme === "API_KEY" && managed !== true;
    });
    const foundId = found ? String(found["id"] ?? "") : "";
    if (foundId) {
      this.authConfigIds.set(slug, foundId);
      return foundId;
    }
    const created = await this.request<Record<string, unknown>>("POST", "/api/v3.1/auth_configs", {
      toolkit: { slug },
      auth_config: {
        type: "use_custom_auth",
        name,
        authScheme: "API_KEY",
        credentials: { generic_api_key: templateKey },
        is_enabled_for_tool_router: true,
      },
    });
    const nested = created["auth_config"] as { id?: string } | undefined;
    const id = String(created["id"] ?? nested?.id ?? "");
    if (!id) throw new ComposioApiError(500, "auth config create returned no id");
    this.authConfigIds.set(slug, id);
    return id;
  }

  /**
   * A DCR OAuth auth config for a custom toolkit (Oxygen). No credentials: the
   * person finishes the OAuth dance in their own browser via the Composio
   * connect link, and the resulting connected account is theirs alone.
   */
  private async ensureDcrAuthConfig(slug: string, name: string): Promise<string> {
    const cached = this.authConfigIds.get(slug);
    if (cached) return cached;
    const list = await this.request<ListEnvelope>(
      "GET",
      `/api/v3.1/auth_configs?toolkit_slug=${encodeURIComponent(slug)}&limit=50`,
    );
    const found = (list.items ?? []).find((item) => {
      const scheme = String(item["auth_scheme"] ?? item["authScheme"] ?? "");
      const managed = item["is_composio_managed"] ?? item["isComposioManaged"];
      return scheme === "DCR_OAUTH" && managed !== true;
    });
    const foundId = found ? String(found["id"] ?? "") : "";
    if (foundId) {
      this.authConfigIds.set(slug, foundId);
      return foundId;
    }
    const created = await this.request<Record<string, unknown>>("POST", "/api/v3.1/auth_configs", {
      toolkit: { slug },
      auth_config: {
        type: "use_custom_auth",
        name,
        authScheme: "DCR_OAUTH",
        is_enabled_for_tool_router: true,
      },
    });
    const nested = created["auth_config"] as { id?: string } | undefined;
    const id = String(created["id"] ?? nested?.id ?? "");
    if (!id) throw new ComposioApiError(500, "auth config create returned no id");
    this.authConfigIds.set(slug, id);
    return id;
  }

  /** The Postiz toolkit's auth config, created lazily when the first person saves a key. */
  private async postizAuthConfig(templateKey: string): Promise<string> {
    return this.ensureApiKeyAuthConfig(POSTIZ_TOOLKIT_SLUG, "Postiz API key", templateKey);
  }

  /**
   * Connect one session user (an agent's Inkbox handle) to a toolkit. The
   * connection carries the key as its state, so agent sessions resolve it by
   * `user_id` without any pinning. Default: the executor fleet token.
   */
  async ensureAccount(userId: string, opts: EnsureAccountOptions = {}): Promise<string> {
    const toolkit = opts.toolkit ?? EXECUTOR_TOOLKIT_SLUG;
    const apiKey = opts.apiKey ?? this.cfg.token;
    if (!apiKey) throw new ComposioApiError(500, `${toolkit.toLowerCase()} is not configured`);
    let ac = opts.authConfigId;
    if (!ac) ac = toolkit === POSTIZ_TOOLKIT_SLUG ? await this.postizAuthConfig(apiKey) : await this.ensureApiKeyAuthConfig(toolkit, toolkit, apiKey);
    const created = await this.request<Record<string, unknown>>("POST", "/api/v3.1/connected_accounts", {
      toolkit,
      user_id: userId,
      auth_config: { id: ac },
      connection: {
        user_id: userId,
        state: { authScheme: "API_KEY", val: { generic_api_key: apiKey } },
      },
    });
    const nested = created["connected_account"] as { id?: string } | undefined;
    const id = String(created["id"] ?? nested?.id ?? "");
    if (!id) throw new ComposioApiError(500, "connected account create returned no id");
    const status = typeof created["status"] === "string" ? created["status"] : "";
    if (status && status !== "ACTIVE") {
      this.log.warn("composio.account_not_active", { userId, toolkit, status });
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

  /**
   * Start the per-person Oxygen OAuth dance through Composio's hosted connect
   * link. DCR_OAUTH carries no shared credential: the person approves in their
   * own browser (Clerk at the toolkit's issuer) and the resulting connected
   * account is theirs alone. Returns the link to redirect the browser to and
   * the account id created for it — still INITIATED until the person finishes.
   * callbackUrl is where Composio sends the browser back, with
   * `?connectedAccountId=…` appended.
   */
  async initiateOxygenLink(userId: string, callbackUrl: string): Promise<{ redirectUrl: string; accountId: string }> {
    const authConfigId = await this.ensureDcrAuthConfig(OXYGEN_TOOLKIT_SLUG, "Oxygen");
    const created = await this.request<Record<string, unknown>>("POST", "/api/v3.1/connected_accounts/link", {
      auth_config_id: authConfigId,
      user_id: userId,
      callback_url: callbackUrl,
    });
    const redirectUrl = String(created["redirect_url"] ?? "");
    const accountId = String(created["connected_account_id"] ?? "");
    if (!redirectUrl || !accountId) throw new ComposioApiError(500, "oxygen link creation returned no redirect url");
    this.log.info("composio.oxygen_link", { userId, accountId });
    return { redirectUrl, accountId };
  }

  /**
   * Full look at one connected account — the OAuth callback verifies status,
   * owner and toolkit with this before promoting a pending account.
   */
  async connectedAccountInfo(id: string): Promise<{ status: string; userId: string; toolkit: string }> {
    const acc = await this.request<Record<string, unknown>>("GET", `/api/v3.1/connected_accounts/${encodeURIComponent(id)}`);
    const nested = acc["toolkit"];
    return {
      status: String(acc["status"] ?? ""),
      userId: String(acc["user_id"] ?? ""),
      toolkit: String((nested as { slug?: unknown })?.slug ?? nested ?? ""),
    };
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

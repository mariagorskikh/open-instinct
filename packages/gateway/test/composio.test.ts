import { describe, expect, it } from "vitest";
import {
  ComposioApiError,
  ComposioPlatform,
  EXECUTOR_TOOLKIT_SLUG,
  OXYGEN_DISCOVERY_URL,
  OXYGEN_MCP_URL,
  OXYGEN_TOOLKIT_SLUG,
  POSTIZ_TOOLKIT_SLUG,
} from "../src/composio.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Mock fetch that records path+body and answers via the given responder. */
function mockFetch(responder: (method: string, path: string, body?: unknown) => Response): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    return responder(method, url.pathname + url.search, body);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

// Executor-focused fixture: oxygen off so the boot-order assertions see only the executor calls.
const cfg = { apiKey: "ak_test", appUrl: "https://executor.example/mcp", token: "tok_secret", oxygen: false };

function bootResponder(): (method: string, path: string, body?: unknown) => Response {
  return (method, path) => {
    if (method === "POST" && path.includes("/custom/toolkits/upsert")) return Response.json({ slug: EXECUTOR_TOOLKIT_SLUG });
    if (method === "GET" && path.startsWith("/api/v3.1/auth_configs")) return Response.json({ items: [] });
    if (method === "POST" && path === "/api/v3.1/auth_configs") return Response.json({ id: "ac_1" });
    if (method === "POST" && path === "/api/v3.1/connected_accounts") return Response.json({ id: "ca_1", status: "ACTIVE" });
    if (method === "POST" && path.includes("/custom/toolkits/sync")) return Response.json({ synced_count: 5, version: 2 });
    if (method === "GET" && path.startsWith("/api/v3.1/connected_accounts/")) return Response.json({ id: "ca_1", status: "ACTIVE" });
    return Response.json({ detail: "not found" }, { status: 404 });
  };
}

describe("ComposioPlatform", () => {
  it("boots in order: upsert, auth config, bootstrap account, sync", async () => {
    const { calls, fetchImpl } = mockFetch(bootResponder());
    const platform = new ComposioPlatform(cfg, { fetchImpl });
    await platform.ensureBoot();

    expect(calls.map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual([
      "POST /api/v3.1/custom/toolkits/upsert",
      "GET /api/v3.1/auth_configs",
      "POST /api/v3.1/auth_configs",
      "POST /api/v3.1/connected_accounts",
      "POST /api/v3.1/custom/toolkits/sync",
    ]);

    const upsert = calls[0]?.body as Record<string, any>;
    expect(upsert["slug"]).toBe(EXECUTOR_TOOLKIT_SLUG);
    expect(upsert["toolkit_config"]["app_url"]).toBe(cfg.appUrl);
    expect(upsert["toolkit_config"]["auth_schemes"][0]["mode"]).toBe("API_KEY");

    const auth = calls[2]?.body as Record<string, any>;
    expect(auth["auth_config"]["credentials"]["generic_api_key"]).toBe(cfg.token);

    const ca = calls[3]?.body as Record<string, any>;
    expect(ca["toolkit"]).toBe(EXECUTOR_TOOLKIT_SLUG);
    expect(ca["user_id"]).toBe("instinct-gateway");
    expect(ca["connection"]["state"]["val"]["generic_api_key"]).toBe(cfg.token);

    const sync = calls[4]?.body as Record<string, unknown>;
    expect(sync).toMatchObject({ slug: EXECUTOR_TOOLKIT_SLUG, connected_account_id: "ca_1" });
  });

  it("reuses an existing API_KEY auth config instead of creating a second one", async () => {
    const { calls, fetchImpl } = mockFetch((method, path) => {
      if (method === "POST" && path.includes("/custom/toolkits/upsert")) return Response.json({ slug: EXECUTOR_TOOLKIT_SLUG });
      if (method === "GET" && path.startsWith("/api/v3.1/auth_configs")) {
        return Response.json({ items: [{ id: "ac_9", auth_scheme: "API_KEY", is_composio_managed: false }] });
      }
      if (method === "POST" && path === "/api/v3.1/connected_accounts") return Response.json({ id: "ca_9", status: "ACTIVE" });
      if (method === "POST" && path.includes("/custom/toolkits/sync")) return Response.json({ synced_count: 1 });
      return Response.json({ detail: "not found" }, { status: 404 });
    });
    const platform = new ComposioPlatform(cfg, { fetchImpl });
    await platform.ensureBoot();

    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v3.1/auth_configs")).toBe(false);
    const ca = calls.find((c) => c.method === "POST" && c.path === "/api/v3.1/connected_accounts")?.body as Record<string, any>;
    expect(ca["auth_config"]["id"]).toBe("ac_9");
  });

  it("creates a per-user connected account under the given user_id", async () => {
    const { calls, fetchImpl } = mockFetch(bootResponder());
    const platform = new ComposioPlatform(cfg, { fetchImpl });
    const id = await platform.ensureAccount("maria");
    expect(id).toBe("ca_1");
    const ca = calls.find((c) => c.method === "POST" && c.path === "/api/v3.1/connected_accounts")?.body as Record<string, any>;
    expect(ca["user_id"]).toBe("maria");
    expect(ca["connection"]["user_id"]).toBe("maria");
  });

  it("reports account activity from status, treating a lookup failure as inactive", async () => {
    const active = new ComposioPlatform(cfg, {
      fetchImpl: (async () => Response.json({ id: "ca_1", status: "ACTIVE" })) as typeof fetch,
    });
    expect(await active.accountActive("ca_1")).toBe(true);

    const disabled = new ComposioPlatform(cfg, {
      fetchImpl: (async () => Response.json({ id: "ca_2", status: "DISABLED" })) as typeof fetch,
    });
    expect(await disabled.accountActive("ca_2")).toBe(false);

    const gone = new ComposioPlatform(cfg, {
      fetchImpl: (async () => Response.json({ detail: "not found" }, { status: 404 })) as typeof fetch,
    });
    expect(await gone.accountActive("ca_3")).toBe(false);
  });

  it("surfaces API failures as ComposioApiError with the status", async () => {
    const platform = new ComposioPlatform(cfg, {
      fetchImpl: (async () => Response.json({ detail: "quota" }, { status: 403 })) as typeof fetch,
    });
    await expect(platform.ensureToolkit()).rejects.toMatchObject({ name: "ComposioApiError", status: 403 });
    await expect(platform.ensureToolkit()).rejects.toBeInstanceOf(ComposioApiError);
  });

  it("boots oxygen by default: DCR toolkit upsert + DCR auth config, no bootstrap account", async () => {
    const { calls, fetchImpl } = mockFetch((method, path) => {
      if (method === "POST" && path.includes("/custom/toolkits/upsert")) return Response.json({ slug: OXYGEN_TOOLKIT_SLUG });
      if (method === "GET" && path.startsWith("/api/v3.1/auth_configs")) return Response.json({ items: [] });
      if (method === "POST" && path === "/api/v3.1/auth_configs") return Response.json({ id: "ac_o1" });
      return Response.json({ detail: "not found" }, { status: 404 });
    });
    const platform = new ComposioPlatform({ apiKey: "ak_test", oxygen: true }, { fetchImpl });
    await platform.ensureBoot();

    expect(platform.oxygenReady).toBe(true);
    expect(platform.executorReady).toBe(false);
    const upsert = calls.find((c) => c.method === "POST" && c.path.includes("/custom/toolkits/upsert"))?.body as Record<string, any>;
    // Same bare-name rule as Postiz: the endpoint prefixes "CUSTOM_" itself.
    expect(upsert["slug"]).toBe("OXYGEN");
    expect(upsert["toolkit_config"]["app_url"]).toBe(OXYGEN_MCP_URL);
    expect(upsert["toolkit_config"]["auth_schemes"][0]).toMatchObject({ mode: "DCR_OAUTH", discovery_url: OXYGEN_DISCOVERY_URL });

    const auth = calls.find((c) => c.method === "POST" && c.path === "/api/v3.1/auth_configs")?.body as Record<string, any>;
    expect(auth["auth_config"]["authScheme"]).toBe("DCR_OAUTH");
    expect(auth["auth_config"]["credentials"]).toBeUndefined();
    // DCR OAuth has no bootstrap account: each person connects in their own browser.
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v3.1/connected_accounts")).toBe(false);
  });

  it("initiates the per-person Oxygen link through the hosted connect flow", async () => {
    const { calls, fetchImpl } = mockFetch((method, path) => {
      if (method === "GET" && path.startsWith("/api/v3.1/auth_configs")) return Response.json({ items: [] });
      if (method === "POST" && path === "/api/v3.1/auth_configs") return Response.json({ id: "ac_o1" });
      if (method === "POST" && path === "/api/v3.1/connected_accounts/link") {
        return Response.json({ link_token: "ln_t", redirect_url: "https://connect.composio.dev/link/ln_1", connected_account_id: "ca_o1" });
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    });
    const platform = new ComposioPlatform({ apiKey: "ak_test" }, { fetchImpl });
    const callback = "https://gw.example.com/oauth/composio/callback?user=usr_1";
    const out = await platform.initiateOxygenLink("maria", callback);
    expect(out).toEqual({ redirectUrl: "https://connect.composio.dev/link/ln_1", accountId: "ca_o1" });
    const link = calls.find((c) => c.method === "POST" && c.path === "/api/v3.1/connected_accounts/link")?.body as Record<string, any>;
    expect(link).toMatchObject({ auth_config_id: "ac_o1", user_id: "maria", callback_url: callback });
  });

  it("reads a connected account's status, owner and toolkit for the callback check", async () => {
    const { fetchImpl } = mockFetch(() => Response.json({ id: "ca_x", status: "ACTIVE", user_id: "maria", toolkit: { slug: "custom_oxygen" } }));
    const platform = new ComposioPlatform({ apiKey: "ak_test" }, { fetchImpl });
    expect(await platform.connectedAccountInfo("ca_x")).toEqual({ status: "ACTIVE", userId: "maria", toolkit: "custom_oxygen" });
  });

  it("boots postiz when a wrapper URL is configured: API_KEY toolkit upsert, no sync without an account", async () => {
    const { calls, fetchImpl } = mockFetch((method, path) => {
      if (method === "POST" && path.includes("/custom/toolkits/upsert")) return Response.json({ slug: POSTIZ_TOOLKIT_SLUG });
      if (method === "GET" && path.startsWith("/api/v3.1/auth_configs")) return Response.json({ items: [] });
      if (method === "POST" && path === "/api/v3.1/auth_configs") return Response.json({ id: "ac_p1" });
      return Response.json({ detail: "not found" }, { status: 404 });
    });
    const platform = new ComposioPlatform(
      { apiKey: "ak_test", oxygen: false, postizAppUrl: "https://postiz-mcp.example/mcp" },
      { fetchImpl },
    );
    await platform.ensureBoot();

    expect(platform.postizReady).toBe(true);
    const upsert = calls.find((c) => c.method === "POST" && c.path.includes("/custom/toolkits/upsert"))?.body as Record<string, any>;
    // The endpoint prefixes custom slugs itself, so the bare name is sent —
    // sending "CUSTOM_POSTIZ" would register the unreachable "CUSTOM_CUSTOM_POSTIZ".
    expect(upsert["slug"]).toBe("POSTIZ");
    expect(upsert["toolkit_config"]["app_url"]).toBe("https://postiz-mcp.example/mcp");
    expect(upsert["toolkit_config"]["auth_schemes"][0]["mode"]).toBe("API_KEY");
    expect(calls.some((c) => c.path.includes("/custom/toolkits/sync"))).toBe(false);
  });

  it("a failing executor does not stop the oxygen boot (and vice versa)", async () => {
    const { fetchImpl } = mockFetch((method, path) => {
      if (method === "POST" && path.includes("/custom/toolkits/upsert")) return Response.json({ slug: "OK" });
      if (method === "GET" && path.startsWith("/api/v3.1/auth_configs")) return Response.json({ items: [] });
      if (method === "POST" && path === "/api/v3.1/auth_configs") return Response.json({ id: "ac_1" });
      if (method === "POST" && path === "/api/v3.1/connected_accounts") return Response.json({ id: "ca_1", status: "ACTIVE" });
      if (method === "POST" && path.includes("/custom/toolkits/sync")) return Response.json({ synced_count: 1 });
      return Response.json({ detail: "not found" }, { status: 404 });
    });
    // Executor upsert fails (403), oxygen upsert succeeds.
    const failingExecutor = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname.includes("/custom/toolkits/upsert") && String(init.body).includes(EXECUTOR_TOOLKIT_SLUG)) {
        return Response.json({ detail: "forbidden" }, { status: 403 });
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    const platform = new ComposioPlatform({ apiKey: "ak_test", appUrl: "https://executor.example/mcp", token: "tok" }, { fetchImpl: failingExecutor });
    await platform.ensureBoot();
    expect(platform.executorReady).toBe(false);
    expect(platform.oxygenReady).toBe(true);
    expect(platform.anyReady).toBe(true);
  });

  it("creates a per-user Postiz account carrying the person's own key", async () => {
    const { calls, fetchImpl } = mockFetch((method, path) => {
      if (method === "GET" && path.startsWith("/api/v3.1/auth_configs")) return Response.json({ items: [] });
      if (method === "POST" && path === "/api/v3.1/auth_configs") return Response.json({ id: "ac_p1" });
      if (method === "POST" && path === "/api/v3.1/connected_accounts") return Response.json({ id: "pca_1", status: "ACTIVE" });
      return Response.json({ detail: "not found" }, { status: 404 });
    });
    const platform = new ComposioPlatform({ apiKey: "ak_test", oxygen: false, postizAppUrl: "https://postiz-mcp.example/mcp" }, { fetchImpl });
    const id = await platform.ensureAccount("maria", { toolkit: POSTIZ_TOOLKIT_SLUG, apiKey: "pk_abcdefgh" });
    expect(id).toBe("pca_1");
    const ca = calls.find((c) => c.method === "POST" && c.path === "/api/v3.1/connected_accounts")?.body as Record<string, any>;
    expect(ca["toolkit"]).toBe(POSTIZ_TOOLKIT_SLUG);
    expect(ca["user_id"]).toBe("maria");
    expect(ca["connection"]["state"]["val"]["generic_api_key"]).toBe("pk_abcdefgh");
  });
});

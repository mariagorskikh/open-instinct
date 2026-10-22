import { describe, expect, it } from "vitest";
import { InkboxProvisioner } from "@open-instinct/inkbox";
import { DEFAULT_MARITIME_LLM_MODEL, MARITIME_AGENT_PORT, agentEnvFor, effectiveToolkits, executorRequested, linkRedirectUriFor, maritimeCreateBody, provisionUser, syncAgentEnv, webhookUrlFor } from "../src/provision.js";
import type { ComposioPlatform } from "../src/composio.js";
import { UserStore } from "../src/store.js";
import { loadTemplateRegistry } from "../src/templates.js";
import { fakeInkbox, fakeMaritime, readyUser, tempDir } from "./helpers.js";

const input = { name: "Maria", phone: "+14155550123", email: "maria@example.com", handle: "maria" };
const shipped = loadTemplateRegistry();

function deps(ink = fakeInkbox(), mar = fakeMaritime(), store = new UserStore(tempDir())) {
  return {
    ink,
    mar,
    store,
    deps: {
      inkbox: ink.provisioner,
      maritime: { apiKey: "mk_test", baseUrl: "https://maritime.test", agentImage: "ghcr.io/x/agent:1", extraEnv: { INSTINCT_MODEL: "anthropic/claude-fable-5-1", EXTRA_TOKEN: "t" } },
      publicUrl: "https://gw.example.com/",
      store,
      anthropicApiKey: "sk-ant",
      composioApiKey: "cmp",
      fetchImpl: mar.fetch,
    },
  };
}

describe("provisionUser", () => {
  it("does not attach a new user to an existing readable identity", async () => {
    const d = deps();
    const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const inkbox = new InkboxProvisioner({ adminApiKey: "test_admin", baseUrl: "https://inkbox.example", fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ method, path, body });
      let value: unknown;
      if (path === "/api/v1/identities/maria") value = { id: "previous_identity", agent_handle: "maria", imessage_enabled: true };
      else if (path === "/api/v1/identities/") {
        if (body.agent_handle === "maria") return new Response("{}", { status: 409 });
        value = { id: "new_identity", agent_handle: body.agent_handle, imessage_enabled: true };
      } else if (path === "/api/v1/api-keys") value = { api_key: "test_scoped" };
      else if (path.endsWith("/signing-key")) value = method === "GET" ? { configured: false } : { signing_key: "test_signing" };
      else if (path === "/api/v1/webhooks/subscriptions") value = { id: "new_subscription" };
      else throw new Error(`Unexpected request: ${method} ${path}`);
      return new Response(JSON.stringify(value), { status: 200 });
    } });
    const user = await provisionUser(input, { ...d.deps, inkbox });
    expect(user).toMatchObject({ identityId: "new_identity", handle: "maria-2", phone: input.phone });
    expect(calls.some((call) => call.path === "/api/v1/identities/maria")).toBe(false);
    expect(calls.find((call) => call.path === "/api/v1/api-keys")?.body.scoped_identity_id).toBe("new_identity");
  });

  it("runs the steps in order and saves a ready record", async () => {
    const d = deps();
    const user = await provisionUser(input, d.deps);
    expect(d.ink.calls).toEqual([
      "provisionIdentity",
      "mintIdentityKey",
      "ensureSigningKey",
      `subscribeWebhooks https://gw.example.com/webhooks/inkbox/${user.id}`,
    ]);
    expect(d.mar.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /api/agents", "POST /api/agents"]);
    expect(d.mar.calls[1]?.headers["authorization"]).toBe("Bearer mk_test");
    expect(user.status).toBe("ready");
    expect(user.identityId).toBe("idn_maria");
    expect(user.identityApiKey).toBe("ik_idn_maria");
    expect(user.signingKey).toBe("whsec_maria");
    expect(user.webhookSubscriptionId).toBe("sub_idn_maria");
    expect(user.maritimeAgentId).toMatch(/^agt_/);
    expect(user.maritimeProjectId).toBe("prj_1");
    expect(d.store.get(user.id)?.status).toBe("ready");
  });

  it("sends the Maritime create body the BYO contract expects, with secrets marked", async () => {
    const d = deps();
    const user = await provisionUser(input, d.deps);
    const body = d.mar.calls[1]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "instinct-maria",
      framework: "custom",
      imageName: "ghcr.io/x/agent:1",
      exposedPort: MARITIME_AGENT_PORT,
      healthCheckPath: "/health",
      desktop: true,
      externalId: user.id,
      idleTtlSeconds: 900,
    });
    expect(body["exposedPort"]).toBe(18789);
    expect(body["useMaritimeLlm"]).toBeUndefined();
    expect(typeof body["instructions"]).toBe("string");
    const env = body["initialEnvVars"] as Array<{ key: string; value: string; isSecret: boolean }>;
    const byKey = Object.fromEntries(env.map((e) => [e.key, e]));
    // The bound port and the exposed port are the same number, stated once.
    expect(byKey["PORT"]).toEqual({ key: "PORT", value: "18789", isSecret: false });
    expect(env.filter((e) => e.key === "PORT")).toHaveLength(1);
    expect(byKey["INKBOX_API_KEY"]).toEqual({ key: "INKBOX_API_KEY", value: "ik_idn_maria", isSecret: true });
    expect(byKey["INKBOX_AGENT_HANDLE"]?.value).toBe("maria");
    expect(byKey["INKBOX_IDENTITY_ID"]?.value).toBe("idn_maria");
    expect(byKey["INSTINCT_OWNER_NAME"]?.value).toBe("Maria");
    expect(byKey["INSTINCT_OWNER_PHONE"]?.value).toBe("+14155550123");
    expect(byKey["INSTINCT_OWNER_EMAIL"]?.value).toBe("maria@example.com");
    expect(byKey["ANTHROPIC_API_KEY"]).toMatchObject({ isSecret: true });
    expect(byKey["COMPOSIO_API_KEY"]).toMatchObject({ isSecret: true });
    // Without COMPOSIO_TOOLKITS core keeps apps disabled, so the key alone would be useless.
    // No platform here, so the gateway-managed custom_oxygen is stripped from the default.
    expect(byKey["COMPOSIO_TOOLKITS"]).toEqual({ key: "COMPOSIO_TOOLKITS", value: "gmail,googlecalendar,googlecontacts,linear", isSecret: false });
    expect(byKey["INSTINCT_COMPUTER"]?.value).toBe("auto");
    expect(byKey["INSTINCT_MODEL"]).toMatchObject({ isSecret: false });
    expect(byKey["EXTRA_TOKEN"]).toMatchObject({ isSecret: true });
    // The signing key verifies webhooks in the gateway and must not travel to the agent.
    expect(env.some((e) => e.value === "whsec_maria")).toBe(false);
  });

  it("omits optional env when not configured", () => {
    const env = agentEnvFor(readyUser({ email: undefined }), { maritime: { apiKey: "k", agentImage: "img" } });
    const keys = env.map((e) => e.key);
    expect(keys).not.toContain("INSTINCT_OWNER_EMAIL");
    expect(keys).not.toContain("ANTHROPIC_API_KEY");
    expect(keys).not.toContain("COMPOSIO_API_KEY");
    expect(keys).not.toContain("COMPOSIO_TOOLKITS");
    expect(keys).not.toContain("INSTINCT_MODEL");
    expect(keys).not.toContain("LINK_CLIENT_ID");
    expect(maritimeCreateBody(readyUser(), { maritime: { apiKey: "k", agentImage: "img", idleTtlSeconds: 60 } })["idleTtlSeconds"]).toBe(60);
    expect(maritimeCreateBody(readyUser(), { maritime: { apiKey: "k", agentImage: "img" } })["desktop"]).toBe(true);
    expect(maritimeCreateBody(readyUser(), { maritime: { apiKey: "k", agentImage: "img", desktop: false } })["desktop"]).toBe(false);
    expect(webhookUrlFor("https://gw.example.com///", "usr x")).toBe("https://gw.example.com/webhooks/inkbox/usr%20x");
  });

  it("keeps the selected Inkbox endpoint with each agent's credentials", () => {
    const env = agentEnvFor(readyUser(), {
      inkboxBaseUrl: "https://inkbox.example", maritime: { apiKey: "test", agentImage: "image" },
    });
    expect(env).toContainEqual({ key: "INKBOX_BASE_URL", value: "https://inkbox.example", isSecret: false });
  });

  it("sends the operator's toolkits with the Composio key and keeps an extraEnv PORT from duplicating", () => {
    const env = agentEnvFor(readyUser(), { composioApiKey: "cmp", composioToolkits: "gmail, slack", maritime: { apiKey: "k", agentImage: "img", extraEnv: { PORT: "8080", COMPOSIO_TOOLKITS: "ignored" } } });
    const byKey = Object.fromEntries(env.map((e) => [e.key, e.value]));
    expect(byKey["COMPOSIO_TOOLKITS"]).toBe("gmail, slack");
    expect(byKey["PORT"]).toBe("18789");
    expect(env.filter((e) => e.key === "PORT")).toHaveLength(1);
    expect(env.filter((e) => e.key === "COMPOSIO_TOOLKITS")).toHaveLength(1);
  });

  it("asks for Maritime's metered LLM and points INSTINCT_MODEL at it", () => {
    const deps = { maritime: { apiKey: "k", agentImage: "img", useMaritimeLlm: true } };
    const body = maritimeCreateBody(readyUser(), deps);
    expect(body["useMaritimeLlm"]).toBe(true);
    const byKey = Object.fromEntries((body["initialEnvVars"] as Array<{ key: string; value: string; isSecret: boolean }>).map((e) => [e.key, e]));
    expect(byKey["INSTINCT_MODEL"]).toEqual({ key: "INSTINCT_MODEL", value: `openai-compatible/${DEFAULT_MARITIME_LLM_MODEL}`, isSecret: false });

    const custom = agentEnvFor(readyUser(), { maritime: { apiKey: "k", agentImage: "img", useMaritimeLlm: true, maritimeModel: "gpt-5.5", extraEnv: { INSTINCT_MODEL: "anthropic/x" } } });
    expect(custom.filter((e) => e.key === "INSTINCT_MODEL")).toEqual([{ key: "INSTINCT_MODEL", value: "openai-compatible/gpt-5.5", isSecret: false }]);
  });

  it("passes Link credentials through with a redirect URI on this gateway", () => {
    const env = agentEnvFor(readyUser({ id: "usr_l" }), {
      maritime: { apiKey: "k", agentImage: "img" },
      link: { clientId: "lc_1", clientSecret: "ls_1", stripePublishableKey: "pk_test_1" },
      publicUrl: "https://gw.example.com/",
    });
    const byKey = Object.fromEntries(env.map((e) => [e.key, e]));
    expect(byKey["LINK_CLIENT_ID"]).toEqual({ key: "LINK_CLIENT_ID", value: "lc_1", isSecret: false });
    expect(byKey["LINK_CLIENT_SECRET"]).toEqual({ key: "LINK_CLIENT_SECRET", value: "ls_1", isSecret: true });
    expect(byKey["STRIPE_PUBLISHABLE_KEY"]).toEqual({ key: "STRIPE_PUBLISHABLE_KEY", value: "pk_test_1", isSecret: false });
    expect(byKey["LINK_REDIRECT_URI"]).toEqual({ key: "LINK_REDIRECT_URI", value: "https://gw.example.com/oauth/link/callback", isSecret: false });
    expect(linkRedirectUriFor("https://gw.example.com/", "usr x")).toBe("https://gw.example.com/oauth/link/callback");
  });

  it("resumes after a failure without repeating finished steps", async () => {
    const d = deps();
    d.ink.fail.ensureSigningKey = 1;
    await expect(provisionUser(input, d.deps)).rejects.toThrow("ensureSigningKey failed");
    const partial = d.store.byHandle("maria")!;
    expect(partial.status).toBe("error");
    expect(partial.error).toContain("ensureSigningKey");
    expect(partial.identityId).toBe("idn_maria");
    expect(partial.identityApiKey).toBe("ik_idn_maria");
    expect(d.mar.calls).toHaveLength(0);

    const user = await provisionUser(input, d.deps);
    expect(user.id).toBe(partial.id);
    expect(user.status).toBe("ready");
    expect(d.ink.calls).toEqual([
      "provisionIdentity",
      "mintIdentityKey",
      "ensureSigningKey",
      "ensureSigningKey",
      `subscribeWebhooks https://gw.example.com/webhooks/inkbox/${user.id}`,
    ]);
  });

  it("reuses an existing Maritime agent for the same external id instead of creating another", async () => {
    const d = deps();
    d.mar.existingAgents.push({ id: "agt_old", externalId: "usr_pinned", projectId: "prj_old" });
    const user = await provisionUser(input, { ...d.deps, userId: "usr_pinned" });
    expect(user.id).toBe("usr_pinned");
    expect(user.maritimeAgentId).toBe("agt_old");
    expect(d.mar.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("recovers from a 409 on create by listing again", async () => {
    const d = deps();
    d.mar.queue.push({ body: [] }, 409, { body: [{ id: "agt_raced", externalId: "usr_r" }] });
    const user = await provisionUser(input, { ...d.deps, userId: "usr_r" });
    expect(user.maritimeAgentId).toBe("agt_raced");
  });

  it("keeps the identity's final handle when Inkbox renamed it", async () => {
    const d = deps();
    const renamed = fakeInkbox();
    const original = renamed.provisioner.provisionIdentity.bind(renamed.provisioner);
    renamed.provisioner.provisionIdentity = async (i) => ({ ...(await original(i)), handle: `${i.handle}-2` });
    const user = await provisionUser(input, { ...d.deps, inkbox: renamed.provisioner });
    expect(user.handle).toBe("maria-2");
    expect((d.mar.calls[1]?.body as { name: string }).name).toBe("instinct-maria-2");
  });

  it("stores the subscription signing key as a fallback", async () => {
    const d = deps(fakeInkbox({ subscriptionSigningKey: "whsec_sub" }));
    const user = await provisionUser(input, d.deps);
    expect(user.signingKey).toBe("whsec_maria");
    expect(user.webhookSigningKey).toBe("whsec_sub");
  });

  it("returns a ready record untouched", async () => {
    const d = deps();
    d.store.save(readyUser());
    const user = await provisionUser(input, d.deps);
    expect(user.maritimeAgentId).toBe("agt_42");
    expect(d.ink.calls).toEqual([]);
  });

  it("surfaces Maritime errors with the server detail", async () => {
    const d = deps();
    d.mar.queue.push({ body: [] }, 402);
    await expect(provisionUser(input, d.deps)).rejects.toThrow("Maritime 402: status 402");
    expect(d.store.byHandle("maria")?.status).toBe("error");
  });
});

describe("templates in provisioning", () => {
  it("applies a template's persona, instructions, model, env and desktop-less sizing", () => {
    const body = maritimeCreateBody(readyUser(), {
      maritime: { apiKey: "k", agentImage: "img", useMaritimeLlm: true, maritimeModel: "gpt-9.9" },
      template: shipped.resolve("gtm-ai"),
    });
    expect(body["desktop"]).toBe(false);
    expect(body["memMb"]).toBe(4096);
    expect(body["vcpus"]).toBe(2);
    const byKey = Object.fromEntries((body["initialEnvVars"] as Array<{ key: string; value: string }>).map((e) => [e.key, e.value]));
    expect(byKey["TEMPLATE_ID"]).toBe("gtm-ai");
    expect(byKey["INSTINCT_PERSONA"]).toContain("# Role — AI-native GTM Operator");
    expect(byKey["INSTINCT_INSTRUCTIONS"]).toContain("explicit approval");
    // The template's model wins over the fleet maritime-llm model.
    expect(byKey["INSTINCT_MODEL"]).toBe("openai-compatible/gpt-5.4");
    // No composio platform here: the gateway-managed custom toolkits are stripped, linear stays.
    expect(byKey["COMPOSIO_TOOLKITS"]).toBe("gmail,googlecalendar,linear");
  });

  it("default template provisions desktop-less with TEMPLATE_ID but no persona", async () => {
    const d = deps();
    const user = await provisionUser(input, { ...d.deps, template: shipped.resolve("default") });
    expect(user.status).toBe("ready");
    expect(d.mar.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /api/agents", "POST /api/agents"]);
    const body = d.mar.calls[1]?.body as Record<string, unknown>;
    expect(body["desktop"]).toBe(false);
    expect(body["memMb"]).toBe(4096);
    expect(body["vcpus"]).toBe(1);
    const byKey = Object.fromEntries((body["initialEnvVars"] as Array<{ key: string; value: string }>).map((e) => [e.key, e.value]));
    expect(byKey["TEMPLATE_ID"]).toBe("default");
    expect(byKey["INSTINCT_PERSONA"]).toBeUndefined();
  });

  it("pushes template skills into /data/skills after the agent exists", async () => {
    const d = deps();
    await provisionUser(input, { ...d.deps, template: shipped.resolve("gtm-ai") });
    const write = d.mar.calls.find((c) => c.method === "PUT" && c.url.includes("/files/write"));
    expect(write).toBeDefined();
    expect(new URL(write!.url).pathname).toBe(`/api/agents/${d.store.byHandle("maria")?.maritimeAgentId}/files/write`);
    expect(write!.body).toMatchObject({ path: "/data/skills/gtm-playbook/SKILL.md" });
    expect(String((write!.body as { content: string }).content)).toContain("Pain-Qualified");
  });

  it("a skills push failure never fails provisioning", async () => {
    const mar = fakeMaritime();
    const inner = mar.fetch;
    mar.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT" && String(input).includes("/files/write")) {
        return new Response(JSON.stringify({ detail: "vm still deploying" }), { status: 503 });
      }
      return inner(input, init);
    }) as typeof fetch;
    const d = deps(fakeInkbox(), mar);
    const user = await provisionUser(input, { ...d.deps, template: shipped.resolve("gtm-ai") });
    expect(user.status).toBe("ready");
    expect(d.store.get(user.id)?.status).toBe("ready");
  });
});

describe("executor wiring", () => {
  it("hands agents a narrow computers-scoped key instead of the fleet key", () => {
    const env = agentEnvFor(readyUser(), { maritime: { apiKey: "mk_fleet", agentImage: "img", computersKey: "mk_narrow" } });
    const entry = env.find((e) => e.key === "MARITIME_API_KEY");
    expect(entry).toEqual({ key: "MARITIME_API_KEY", value: "mk_narrow", isSecret: true });
    expect(env.some((e) => e.value === "mk_fleet")).toBe(false);

    const without = agentEnvFor(readyUser(), { maritime: { apiKey: "mk_fleet", agentImage: "img" } });
    expect(without.some((e) => e.key === "MARITIME_API_KEY")).toBe(false);
  });

  it("computes the effective toolkit list and detects an executor request", () => {
    const gtm = shipped.resolve("gtm-ai");
    expect(executorRequested({ template: gtm })).toBe(true);
    expect(effectiveToolkits({ template: gtm })).toBe("gmail,googlecalendar,custom_executor,linear,custom_oxygen");
    expect(executorRequested({ template: shipped.resolve("default") })).toBe(false);
    expect(executorRequested({ composioToolkits: "custom_executor,gmail" })).toBe(true);
    expect(executorRequested({ composioToolkits: "gmail,googlecalendar" })).toBe(false);
    expect(effectiveToolkits({ composioToolkits: "gmail, slack" })).toBe("gmail, slack");
    expect(effectiveToolkits({})).toBe("gmail,googlecalendar,googlecontacts,linear,custom_oxygen");
  });

  it("strips gateway-managed toolkits that never booted from the agent env", async () => {
    const d = deps();
    await provisionUser(input, { ...d.deps, template: shipped.resolve("gtm-ai") });
    const body = d.mar.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/agents"))?.body as Record<string, unknown>;
    const byKey = Object.fromEntries((body["initialEnvVars"] as Array<{ key: string; value: string }>).map((e) => [e.key, e.value]));
    // custom_executor and custom_oxygen need gateway boot state; linear is Composio-managed and stays.
    expect(byKey["COMPOSIO_TOOLKITS"]).toBe("gmail,googlecalendar,linear");
    expect(byKey["COMPOSIO_MODE"]).toBe("router");
  });

  it("keeps gateway-managed toolkits when the matching boot flags are on", async () => {
    const d = deps();
    const composio = { executorReady: true, oxygenReady: true, postizReady: false } as unknown as ComposioPlatform;
    await provisionUser(input, { ...d.deps, composio, template: shipped.resolve("gtm-ai") });
    const body = d.mar.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/agents"))?.body as Record<string, unknown>;
    const byKey = Object.fromEntries((body["initialEnvVars"] as Array<{ key: string; value: string }>).map((e) => [e.key, e.value]));
    expect(byKey["COMPOSIO_TOOLKITS"]).toBe("gmail,googlecalendar,custom_executor,linear,custom_oxygen");
  });

  it("adds custom_postiz to the toolkit list only when the person saved a key", async () => {
    const d = deps();
    const composio = { executorReady: true, oxygenReady: true, postizReady: true } as unknown as ComposioPlatform;

    // Saved key: the toolkit joins the list even though no template mentions it.
    const withKey = agentEnvFor(readyUser({ postizKey: "pk_abcdefgh" }), {
      composioApiKey: "cmp",
      composio,
      template: shipped.resolve("gtm-ai"),
      maritime: { apiKey: "k", agentImage: "img" },
    });
    const withKeyList = withKey.find((e) => e.key === "COMPOSIO_TOOLKITS")?.value ?? "";
    expect(withKeyList.split(",")).toContain("custom_postiz");

    // No key: the toolkit stays out, and a template listing it would be stripped.
    const withoutKey = agentEnvFor(readyUser(), {
      composioApiKey: "cmp",
      composio,
      template: shipped.resolve("gtm-ai"),
      maritime: { apiKey: "k", agentImage: "img" },
    });
    expect(withoutKey.find((e) => e.key === "COMPOSIO_TOOLKITS")?.value).not.toContain("custom_postiz");

    // Wrapper down: a saved key must not leave a dead toolkit in the list.
    const wrapperDown = agentEnvFor(readyUser({ postizKey: "pk_abcdefgh" }), {
      composioApiKey: "cmp",
      composio: { ...composio, postizReady: false } as unknown as ComposioPlatform,
      template: shipped.resolve("gtm-ai"),
      maritime: { apiKey: "k", agentImage: "img" },
    });
    expect(wrapperDown.find((e) => e.key === "COMPOSIO_TOOLKITS")?.value).not.toContain("custom_postiz");
  });

  it("rewrites the toolkit list when a drop and the postiz add cancel out numerically", () => {
    // One dead toolkit out (oxygen) and one BYOK toolkit in (postiz): equal
    // counts, different contents — a length-based guard would keep the stale
    // base string and leave agents with dead custom_oxygen and no custom_postiz.
    const composio = { executorReady: true, oxygenReady: false, postizReady: true } as unknown as ComposioPlatform;
    const env = agentEnvFor(readyUser({ postizKey: "pk_abcdefgh" }), {
      composioApiKey: "cmp",
      composio,
      composioToolkits: "gmail,googlecalendar,custom_executor,linear,custom_oxygen",
      template: shipped.resolve("gtm-ai"),
      maritime: { apiKey: "k", agentImage: "img" },
    });
    const list = env.find((e) => e.key === "COMPOSIO_TOOLKITS")?.value ?? "";
    expect(list.split(",")).toContain("custom_postiz");
    expect(list.split(",")).not.toContain("custom_oxygen");
    expect(list.split(",")).toContain("custom_executor");
  });

  it("connects an executor account under the handle, reuses it while active, replaces it when dead", async () => {
    const d = deps();
    const created: string[] = [];
    const live = { value: true };
    const composio = {
      executorReady: true,
      accountActive: async () => live.value,
      ensureAccount: async (handle: string) => {
        created.push(handle);
        return `ca_${created.length}`;
      },
    } as unknown as ComposioPlatform;

    const user = await provisionUser(input, { ...d.deps, composio, template: shipped.resolve("gtm-ai") });
    expect(created).toEqual(["maria"]);
    expect(user.composioAccountId).toBe("ca_1");
    expect(d.store.get(user.id)?.composioAccountId).toBe("ca_1");

    // Stored id still active: the next run reuses it, no second account.
    d.store.save({ ...user, status: "provisioning" });
    const again = await provisionUser(input, { ...d.deps, composio, template: shipped.resolve("gtm-ai"), userId: user.id });
    expect(again.composioAccountId).toBe("ca_1");
    expect(created).toEqual(["maria"]);

    // Stored id went dead: a fresh one replaces it.
    live.value = false;
    d.store.save({ ...again, status: "provisioning" });
    const third = await provisionUser(input, { ...d.deps, composio, template: shipped.resolve("gtm-ai"), userId: user.id });
    expect(third.composioAccountId).toBe("ca_2");
    expect(created).toEqual(["maria", "maria"]);
  });

  it("a composio failure never fails provisioning", async () => {
    const d = deps();
    const composio = {
      executorReady: true,
      accountActive: async () => false,
      ensureAccount: async () => {
        throw new Error("composio down");
      },
    } as unknown as ComposioPlatform;
    const user = await provisionUser(input, { ...d.deps, composio, template: shipped.resolve("gtm-ai") });
    expect(user.status).toBe("ready");
    expect(user.composioAccountId).toBeUndefined();
  });

  it("mints a Postiz connected account from the saved BYOK key, reusing it while active", async () => {
    const d = deps();
    const created: Array<{ handle: string; opts: { toolkit?: string; apiKey?: string } }> = [];
    const live = { value: true };
    const composio = {
      postizReady: true,
      accountActive: async () => live.value,
      ensureAccount: async (handle: string, opts: { toolkit?: string; apiKey?: string } = {}) => {
        created.push({ handle, opts });
        return `pca_${created.length}`;
      },
    } as unknown as ComposioPlatform;
    d.store.save({ ...readyUser(), status: "provisioning", postizKey: "pk_abcdefgh" });

    const user = await provisionUser(input, { ...d.deps, composio, userId: "usr_test", template: shipped.resolve("gtm-ai") });
    expect(created).toEqual([{ handle: "maria", opts: { toolkit: "CUSTOM_POSTIZ", apiKey: "pk_abcdefgh" } }]);
    expect(user.postizComposioAccountId).toBe("pca_1");

    // Stored id still active: the next run reuses it, no second account.
    d.store.save({ ...user, status: "provisioning" });
    const again = await provisionUser(input, { ...d.deps, composio, userId: "usr_test", template: shipped.resolve("gtm-ai") });
    expect(again.postizComposioAccountId).toBe("pca_1");
    expect(created).toHaveLength(1);
  });

  it("skips the Postiz account when the person saved no key", async () => {
    const d = deps();
    const ensureAccount = async (): Promise<string> => {
      throw new Error("must not be called");
    };
    const composio = { postizReady: true, accountActive: async () => true, ensureAccount } as unknown as ComposioPlatform;
    const user = await provisionUser(input, { ...d.deps, composio, template: shipped.resolve("gtm-ai") });
    expect(user.status).toBe("ready");
    expect(user.postizComposioAccountId).toBeUndefined();
  });

  it("pushes the person's brain repo into the agent's files", async () => {
    const d = deps();
    const github: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        github.push(url);
        if (/https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(url)) return Response.json({ default_branch: "main" }, { status: 200 });
        if (url.includes("/git/trees/")) return Response.json({ tree: [{ path: "NOTES.md", type: "blob", sha: "s1", size: 7 }] }, { status: 200 });
        if (url.includes("/git/blobs/")) return new Response("# notes", { status: 200 });
        return Response.json({ detail: "not found" }, { status: 404 });
      }
      return d.mar.fetch(input as string, init);
    }) as typeof fetch;

    const user = await provisionUser(
      { ...input, brainRepo: "acme/handbook", brainToken: "ghp_abcdefgh123456" },
      { ...d.deps, fetchImpl, template: shipped.resolve("gtm-ai") },
    );
    expect(user.status).toBe("ready");
    expect(github.some((u) => u.endsWith("/repos/acme/handbook"))).toBe(true);
    const writes = d.mar.calls.filter((c) => c.method === "PUT" && c.url.includes("/files/write"));
    expect(writes.some((c) => (c.body as { path: string }).path === "/data/brain/NOTES.md")).toBe(true);
    const skillWrite = writes.find((c) => (c.body as { path: string }).path.startsWith("/data/skills/"));
    expect(skillWrite).toBeDefined();
  });

  it("a brain failure never fails provisioning", async () => {
    const d = deps();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.github.com")) return Response.json({ message: "Not Found" }, { status: 404 });
      return d.mar.fetch(input as string, init);
    }) as typeof fetch;
    const user = await provisionUser(
      { ...input, brainRepo: "acme/handbook" },
      { ...d.deps, fetchImpl, template: shipped.resolve("gtm-ai") },
    );
    expect(user.status).toBe("ready");
  });
});

describe("syncAgentEnv", () => {
  const ready = readyUser({ templateId: "gtm-ai" });
  const template = shipped.resolve("gtm-ai");

  it("pushes only the keys that differ and leaves matching ones alone", async () => {
    const d = deps();
    // The agent already has PORT and COMPOSIO_TOOLKITS, but the toolkit list is stale.
    d.mar.env[ready.maritimeAgentId!] = [
      { key: "PORT", value: String(MARITIME_AGENT_PORT) },
      { key: "COMPOSIO_TOOLKITS", value: "gmail,googlecalendar" },
    ];
    const result = await syncAgentEnv(ready, { ...d.deps, template });
    // Every expected key that is missing or different got pushed.
    expect(result.synced).toBeGreaterThan(0);
    const envCalls = d.mar.calls.filter((c) => c.url.endsWith("/env") && c.method === "POST");
    const pushedKeys = envCalls.map((c) => (c.body as { key: string }).key);
    expect(pushedKeys).toContain("COMPOSIO_TOOLKITS");
    expect(pushedKeys).not.toContain("PORT"); // already matches, not re-pushed
    // With no composio platform in deps, gateway-managed toolkits (executor,
    // oxygen) are stripped by the flag-based strip — only Composio-managed ones
    // (gmail, calendar, linear) survive. Working as designed, not a sync bug.
    const toolkits = d.mar.env[ready.maritimeAgentId!].find((r) => r.key === "COMPOSIO_TOOLKITS");
    expect(toolkits?.value).toBe("gmail,googlecalendar,linear");
  });

  it("re-pushes a secret even when Maritime already has one (masked value is untrustworthy)", async () => {
    const d = deps();
    d.mar.env[ready.maritimeAgentId!] = [
      { key: "ANTHROPIC_API_KEY", value: "****old1", isSecret: true },
      { key: "PORT", value: String(MARITIME_AGENT_PORT) },
    ];
    await syncAgentEnv(ready, { ...d.deps, template });
    const secretPush = d.mar.calls.find((c) => c.url.endsWith("/env") && c.method === "POST" && (c.body as { key: string }).key === "ANTHROPIC_API_KEY");
    expect(secretPush).toBeDefined();
    expect((secretPush!.body as { value: string }).value).toBe("sk-ant");
    // Non-secret PORT still matches and is not re-pushed.
    expect(d.mar.calls.filter((c) => c.method === "POST" && (c.body as { key: string }).key === "PORT")).toHaveLength(0);
  });

  it("provisionUser re-syncs a ready agent's env without recreating the agent", async () => {
    const d = deps();
    d.store.save(ready);
    d.mar.env[ready.maritimeAgentId!] = [{ key: "COMPOSIO_TOOLKITS", value: "gmail,googlecalendar" }];
    await provisionUser({ ...input, handle: ready.handle }, { ...d.deps, template, userId: ready.id });
    // The fire-and-forget sync resolves on the microtask queue; let it land.
    await new Promise((r) => setTimeout(r, 0));
    const envPush = d.mar.calls.find((c) => c.url.endsWith("/env") && c.method === "POST" && (c.body as { key: string }).key === "COMPOSIO_TOOLKITS");
    expect(envPush).toBeDefined();
    // No agent-create or identity call went out — nothing was recreated.
    expect(d.mar.calls.some((c) => c.url.endsWith("/api/agents") && c.method === "POST")).toBe(false);
    expect(d.ink.calls).toEqual([]);
  });
});

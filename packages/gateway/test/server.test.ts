import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { decodeEvent } from "@open-instinct/core";
import type { ComposioPlatform } from "../src/composio.js";
import { silentLogger } from "../src/logger.js";
import type { RouterInfo } from "../src/pages.js";
import { MARITIME_AGENT_PORT } from "../src/provision.js";
import { type GatewayOptions, createGateway } from "../src/server.js";
import { type UserRecord, UserStore } from "../src/store.js";
import { fakeInkbox, fakeMaritime, imessageEvent, readyUser, signHeaders, tempDir } from "./helpers.js";

const servers: Array<ReturnType<typeof createGateway>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

interface BootOpts {
  signupSecret?: string;
  withInkbox?: boolean;
  routerInfoFor?: GatewayOptions["routerInfoFor"];
  signupLimits?: GatewayOptions["signupLimits"];
  trustProxy?: boolean;
  link?: GatewayOptions["link"];
  notifyExisting?: GatewayOptions["notifyExisting"];
  seed?: UserRecord[];
  now?: () => number;
  adminToken?: string;
  githubToken?: string;
  composio?: ComposioPlatform;
}

async function boot(opts: BootOpts = {}) {
  const store = new UserStore(tempDir());
  for (const u of opts.seed ?? []) store.save(u);
  const ink = fakeInkbox();
  const mar = fakeMaritime();
  const server = createGateway({
    store,
    publicUrl: "https://gw.example.com",
    inkbox: opts.withInkbox === false ? undefined : ink.provisioner,
    maritime: { apiKey: "mk_test", baseUrl: "https://maritime.test", agentImage: "img:1" },
    signupSecret: opts.signupSecret,
    logger: silentLogger,
    fetchImpl: mar.fetch,
    routerInfoFor: opts.routerInfoFor,
    signupLimits: opts.signupLimits,
    trustProxy: opts.trustProxy,
    link: opts.link,
    notifyExisting: opts.notifyExisting,
    now: opts.now,
    adminToken: opts.adminToken,
    githubToken: opts.githubToken,
    composio: opts.composio,
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { store, ink, mar, base, server };
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
}

function signup(base: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/signup`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("gateway http", () => {
  it("serves health and the landing page", async () => {
    const { base } = await boot();
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, users: 0, signup: true });
    const page = await fetch(base);
    expect(page.headers.get("content-type")).toContain("text/html");
    const text = await page.text();
    expect(text).toContain("Open Instinct");
    expect(text).toContain('action="/api/signup"');
    expect(text).not.toContain("inviteCode");
    expect(text).toContain("github.com");
  });

  it("signs up over json, provisions in the background and serves the connect page", async () => {
    const { base, store, ink, mar } = await boot();
    const res = await signup(base, { name: "Maria", phone: "415 555 0123", handle: "Maria" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { userId: string; connectUrl: string };
    expect(body.connectUrl).toBe(`https://gw.example.com/connect/${body.userId}`);
    await waitFor(() => store.get(body.userId)?.status === "ready");
    expect(ink.calls[3]).toBe(`subscribeWebhooks https://gw.example.com/webhooks/inkbox/${body.userId}`);
    expect(mar.calls.some((c) => c.method === "POST")).toBe(true);

    const status = await fetch(`${base}/api/users/${body.userId}`);
    const pub = (await status.json()) as Record<string, unknown>;
    expect(pub["status"]).toBe("ready");
    expect(pub["name"]).toBeUndefined();
    expect(pub["error"]).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain("ik_");
    expect(JSON.stringify(pub)).not.toContain("whsec_");

    const connect = await fetch(`${base}/connect/${body.userId}`);
    const page = await connect.text();
    expect(connect.status).toBe(200);
    expect(page).toContain("connect @maria");
    expect(page).toContain("+14155550199");
    // The sms: button is built for this handle, never from the org-wide placeholder link.
    expect(page).toContain('href="sms:+14155550199&amp;body=connect%20%40maria"');
    expect(page).not.toContain("connect%20%40handle");
    // The shared QR encodes the placeholder handle, so it is not shown.
    expect(page).not.toContain("data:image/png;base64,");
    expect(page).toContain("Ready");
    expect(page).not.toContain('http-equiv="refresh"');
    // Router info is cached, so a second page view does not call Inkbox again.
    await fetch(`${base}/connect/${body.userId}`);
    expect(ink.calls.filter((c) => c === "routerInfo")).toHaveLength(1);
  });

  it("shows a QR only when per-user router info names this handle", async () => {
    const asked: string[] = [];
    const perUser = async (u: UserRecord): Promise<RouterInfo> => {
      asked.push(u.identityApiKey);
      return { number: "+14155550199", connectCommand: `connect @${u.handle}`, smsLink: `sms:+14155550199&body=connect%20%40${u.handle}`, qrPngDataUrl: "data:image/png;base64,QUJD" };
    };
    const { base } = await boot({ routerInfoFor: perUser, seed: [readyUser({ id: "usr_q", handle: "maria" })] });
    const page = await (await fetch(`${base}/connect/usr_q`)).text();
    expect(asked).toEqual(["ik_secret"]);
    expect(page).toContain('src="data:image/png;base64,QUJD"');
    expect(page).toContain("connect%20%40maria");

    const wrong = async (): Promise<RouterInfo> => ({ number: "+14155550199", connectCommand: "connect @bob", smsLink: "sms:+14155550199&body=connect%20%40bob", qrPngDataUrl: "data:image/png;base64,Qk9C" });
    const other = await boot({ routerInfoFor: wrong, seed: [readyUser({ id: "usr_w", handle: "maria" })] });
    const wrongPage = await (await fetch(`${other.base}/connect/usr_w`)).text();
    expect(wrongPage).not.toContain("Qk9C");
    expect(wrongPage).toContain("connect%20%40maria");
  });

  it("handles form posts with a redirect and shows field errors inline", async () => {
    const { base } = await boot({ signupSecret: "secret-code" });
    const landing = await (await fetch(base)).text();
    expect(landing).toContain('name="inviteCode"');

    const bad = await fetch(`${base}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ name: "Maria", phone: "123", handle: "maria", inviteCode: "nope" }).toString(),
      redirect: "manual",
    });
    expect(bad.status).toBe(400);
    const text = await bad.text();
    expect(text).toContain("Invite code is not valid.");
    expect(text).toContain("country code");
    expect(text).toContain('value="Maria"');

    const good = await fetch(`${base}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ name: "Maria", phone: "+14155550123", handle: "maria", inviteCode: "secret-code" }).toString(),
      redirect: "manual",
    });
    expect(good.status).toBe(303);
    expect(good.headers.get("location")).toMatch(/^\/connect\/usr_/);
  });

  it("gives a repeat phone a brand-new agent and never reveals the existing record", async () => {
    const notified: string[] = [];
    const { base, store } = await boot({ notifyExisting: async (u, url) => void notified.push(`${u.id} ${url}`) });
    store.save(readyUser({ id: "usr_seedmaria", name: "Maria Secret", handle: "maria", phone: "+14155550123" }));

    const samePhone = await signup(base, { name: "x", phone: "+14155550123", handle: "zzz-random" });
    expect(samePhone.status).toBe(202);
    const body = (await samePhone.json()) as Record<string, unknown>;
    // The caller learns only about the record just created for them.
    expect(body).toMatchObject({ status: "provisioning", templateId: "default" });
    expect(String(body.userId)).toMatch(/^usr_/);
    expect(body.userId).not.toBe("usr_seedmaria");
    expect(String(body.connectUrl)).toContain(String(body.userId));
    expect(JSON.stringify(body)).not.toContain("usr_seedmaria");
    expect(JSON.stringify(body)).not.toContain("Maria Secret");

    const asHtml = await fetch(`${base}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ name: "x", phone: "+14155550123", handle: "zzz-two" }).toString(),
      redirect: "manual",
    });
    expect(asHtml.status).toBe(303);
    const location = asHtml.headers.get("location") ?? "";
    expect(location).toMatch(/^\/connect\/usr_/);
    expect(location).not.toContain("usr_seedmaria");

    // The existing record is untouched, and a fresh agent earns no reuse notice.
    expect(notified).toEqual([]);
    expect(store.all()).toHaveLength(3);
    expect(store.byHandle("maria")?.id).toBe("usr_seedmaria");
    expect(store.byHandle("zzz-random")?.phone).toBe("+14155550123");
  });

  it("hides handle conflicts behind a generic error unless an invite code gates the form", async () => {
    const open = await boot();
    open.store.save(readyUser({ id: "usr_a", handle: "maria", phone: "+14155550123" }));
    const taken = await signup(open.base, { name: "Other", phone: "+14155550999", handle: "maria" });
    expect(taken.status).toBe(400);
    expect(await taken.json()).toEqual({ error: "could not create" });

    const gated = await boot({ signupSecret: "s" });
    gated.store.save(readyUser({ id: "usr_a", handle: "maria", phone: "+14155550123" }));
    const taken2 = await signup(gated.base, { name: "Other", phone: "+14155550999", handle: "maria", inviteCode: "s" });
    expect(taken2.status).toBe(409);
    expect(await taken2.json()).toMatchObject({ error: "handle taken" });
  });

  it("re-submitting for a record stuck in provisioning restarts provisioning with a neutral reply", async () => {
    const stuck = readyUser({ id: "usr_stuck", handle: "maria", phone: "+14155550123", status: "provisioning", identityId: "", identityApiKey: "", signingKey: "", maritimeAgentId: undefined });
    const { base, store, ink } = await boot({ seed: [stuck] });
    const retry = await signup(base, { name: "Maria", phone: "+14155550123", handle: "maria" });
    expect(retry.status).toBe(202);
    const retryBody = (await retry.json()) as Record<string, unknown>;
    expect(retryBody).toMatchObject({ status: "pending", userId: "usr_stuck", handle: "maria" });
    expect(String(retryBody.connectUrl)).toContain("usr_stuck");
    await waitFor(() => store.get("usr_stuck")?.status === "ready");
    expect(ink.calls[0]).toBe("provisionIdentity");
    expect(store.all()).toHaveLength(1);

    // A ready record is left alone — the JSON reply still identifies the caller's own agent.
    const again = await signup(base, { name: "Maria", phone: "+14155550123", handle: "maria" });
    expect(again.status).toBe(202);
    expect((await again.json()) as Record<string, unknown>).toMatchObject({ status: "pending", userId: "usr_stuck" });
    await new Promise((r) => setTimeout(r, 30));
    expect(ink.calls.filter((c) => c === "provisionIdentity")).toHaveLength(1);

    // The HTML path for the same record still renders the pending page.
    const htmlRetry = await fetch(`${base}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ name: "Maria", phone: "+14155550123", handle: "maria" }).toString(),
      redirect: "manual",
    });
    expect(htmlRetry.status).toBe(202);
    const page = await htmlRetry.text();
    expect(page).toContain("Check your phone");
    expect(page).toContain("connect @maria");
  });

  it("resumePending restarts every record a crash left in provisioning", async () => {
    const seed = [
      readyUser({ id: "usr_p1", handle: "p-one", phone: "+14155550001", status: "provisioning", identityId: "", identityApiKey: "", signingKey: "", maritimeAgentId: undefined }),
      readyUser({ id: "usr_p2", handle: "p-two", phone: "+14155550002", status: "provisioning", identityId: "idn_p2", identityApiKey: "ik_p2", signingKey: "whsec_p2", maritimeAgentId: undefined }),
      readyUser({ id: "usr_ok", handle: "fine", phone: "+14155550003" }),
      readyUser({ id: "usr_err", handle: "broken", phone: "+14155550004", status: "error" }),
    ];
    const { store, server, ink } = await boot({ seed });
    expect(server.resumePending()).toBe(2);
    await waitFor(() => store.get("usr_p1")?.status === "ready" && store.get("usr_p2")?.status === "ready");
    // p2 already had its identity and keys, so only the webhook and the agent were created for it.
    expect(ink.calls.filter((c) => c === "provisionIdentity")).toHaveLength(1);
    expect(store.get("usr_err")?.status).toBe("error");
    expect(store.get("usr_ok")?.maritimeAgentId).toBe("agt_42");
  });

  it("backfillWebhookEvents tops up every ready user's subscription, skips the rest, and survives a failure", async () => {
    const seed = [
      readyUser({ id: "usr_a", handle: "a-one", phone: "+14155550011", webhookSubscriptionId: "sub_a" }),
      // Provisioned before the gateway recorded subscription ids: nothing to patch.
      readyUser({ id: "usr_b", handle: "b-two", phone: "+14155550012" }),
      // Still provisioning: provisionUser subscribes it with the full event list itself.
      readyUser({ id: "usr_c", handle: "c-three", phone: "+14155550013", status: "provisioning", maritimeAgentId: undefined, webhookSubscriptionId: "sub_c" }),
      readyUser({ id: "usr_d", handle: "d-four", phone: "+14155550014", webhookSubscriptionId: "sub_d" }),
    ];
    const { server, ink } = await boot({ seed });
    ink.fail.ensureWebhookEvents = 1;
    expect(await server.backfillWebhookEvents()).toBe(1);
    expect(ink.calls.filter((c) => c.startsWith("ensureWebhookEvents"))).toEqual(["ensureWebhookEvents sub_a", "ensureWebhookEvents sub_d"]);
    expect(await server.backfillWebhookEvents()).toBe(2);

    const relayOnly = await boot({ seed, withInkbox: false });
    expect(await relayOnly.server.backfillWebhookEvents()).toBe(0);
    expect(relayOnly.ink.calls).toEqual([]);
  });

  it("rate-limits signups per address and caps pending signups globally", async () => {
    const { base, store } = await boot({ signupLimits: { perIp: 2, windowMs: 60_000, maxPending: 3, pendingWindowMs: 3_600_000 } });
    const a = await signup(base, { name: "A", phone: "+14155550001", handle: "aaa-one" });
    const b = await signup(base, { name: "B", phone: "+14155550002", handle: "bbb-two" });
    const c = await signup(base, { name: "C", phone: "+14155550003", handle: "ccc-three" });
    expect([a.status, b.status, c.status]).toEqual([202, 202, 429]);
    expect(await c.json()).toMatchObject({ error: expect.stringContaining("too many") });
    expect(store.all()).toHaveLength(2);

    // X-Forwarded-For is ignored unless the gateway is told to trust it.
    const spoofed = await signup(base, { name: "D", phone: "+14155550004", handle: "ddd-four" }, { "x-forwarded-for": "203.0.113.9" });
    expect(spoofed.status).toBe(429);

    const trusted = await boot({ trustProxy: true, signupLimits: { perIp: 1, windowMs: 60_000, maxPending: 2, pendingWindowMs: 3_600_000 } });
    expect((await signup(trusted.base, { name: "A", phone: "+14155550011", handle: "aaa-eleven" }, { "x-forwarded-for": "203.0.113.1" })).status).toBe(202);
    expect((await signup(trusted.base, { name: "B", phone: "+14155550012", handle: "bbb-twelve" }, { "x-forwarded-for": "203.0.113.2, 10.0.0.1" })).status).toBe(202);
    // Third address is under its own per-IP budget but the pending cap is reached.
    const capped = await signup(trusted.base, { name: "C", phone: "+14155550013", handle: "ccc-thirteen" }, { "x-forwarded-for": "203.0.113.3" });
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ error: expect.stringContaining("paused") });
    expect(trusted.store.all()).toHaveLength(2);
  });

  it("disables signup without a provisioner", async () => {
    const { base } = await boot({ withInkbox: false });
    const page = await (await fetch(base)).text();
    expect(page).toContain("Signups are closed");
    const res = await fetch(`${base}/api/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(503);
  });

  it("relays webhooks: 404 unknown user, 401 bad signature, 204 then forward", async () => {
    const { base, store, mar } = await boot();
    const user = store.save(readyUser());
    const raw = JSON.stringify(imessageEvent("evt_http", "conv_http"));

    expect((await fetch(`${base}/webhooks/inkbox/usr_nobody`, { method: "POST", body: raw, headers: signHeaders(raw, user.signingKey) })).status).toBe(404);
    expect((await fetch(`${base}/webhooks/inkbox/${user.id}`, { method: "POST", body: raw, headers: signHeaders(raw, "whsec_wrong") })).status).toBe(401);
    expect((await fetch(`${base}/webhooks/inkbox/${user.id}`, { method: "GET" })).status).toBe(405);

    const ok = await fetch(`${base}/webhooks/inkbox/${user.id}`, { method: "POST", body: raw, headers: signHeaders(raw, user.signingKey) });
    expect(ok.status).toBe(204);
    await waitFor(() => mar.calls.length === 1);
    expect(mar.calls[0]?.url).toBe("https://maritime.test/api/agents/agt_42/chat");
    expect((mar.calls[0]?.body as { conversation_id: string }).conversation_id).toBe("conv_http");

    // Same event id again: accepted on the wire, dropped before Maritime.
    const dup = await fetch(`${base}/webhooks/inkbox/${user.id}`, { method: "POST", body: raw, headers: signHeaders(raw, user.signingKey) });
    expect(dup.status).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect(mar.calls).toHaveLength(1);
  });

  it("calls onInbound with the user and the parsed event only after the signature passed", async () => {
    const store = new UserStore(tempDir());
    const user = store.save(readyUser({ phone: "" }));
    const seen: Array<{ userId: string; eventId: string }> = [];
    const server = createGateway({
      store,
      publicUrl: "https://gw.example.com",
      maritime: { apiKey: "mk_test", baseUrl: "https://maritime.test", agentImage: "img:1" },
      logger: silentLogger,
      fetchImpl: fakeMaritime().fetch,
      onInbound: (u, event) => {
        seen.push({ userId: u.id, eventId: String(event["id"]) });
        throw new Error("hooks must not break the relay");
      },
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const raw = JSON.stringify(imessageEvent("evt_hook", "conv_hook"));
    expect((await fetch(`${base}/webhooks/inkbox/${user.id}`, { method: "POST", body: raw, headers: signHeaders(raw, "whsec_wrong") })).status).toBe(401);
    expect(seen).toEqual([]);
    expect((await fetch(`${base}/webhooks/inkbox/${user.id}`, { method: "POST", body: raw, headers: signHeaders(raw, user.signingKey) })).status).toBe(204);
    expect(seen).toEqual([{ userId: user.id, eventId: "evt_hook" }]);
    expect(store.byPhone("")).toBeUndefined();
  });

  it("onInbound: a rejected async hook is logged, not fatal, and mutations never reach the relayed event", async () => {
    const store = new UserStore(tempDir());
    const user = store.save(readyUser());
    const mar = fakeMaritime();
    const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const logger = { ...silentLogger, warn: (msg: string, meta?: Record<string, unknown>) => warnings.push({ msg, meta }) };
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const server = createGateway({
        store,
        publicUrl: "https://gw.example.com",
        maritime: { apiKey: "mk_test", baseUrl: "https://maritime.test", agentImage: "img:1" },
        logger,
        fetchImpl: mar.fetch,
        onInbound: async (u, event) => {
          // Try to rewrite what the agent will see, and the user record, then fail.
          const message = (event["data"] as { message: Record<string, unknown> }).message;
          message["content"] = "INJECTED";
          message["remote_number"] = "+19990000000";
          u.phone = "+19990000000";
          await new Promise((r) => setTimeout(r, 5));
          throw new Error("async hook blew up");
        },
      });
      servers.push(server);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const raw = JSON.stringify(imessageEvent("evt_async", "conv_async"));
      expect((await fetch(`${base}/webhooks/inkbox/${user.id}`, { method: "POST", body: raw, headers: signHeaders(raw, user.signingKey) })).status).toBe(204);
      await waitFor(() => mar.calls.some((c) => c.url.endsWith("/chat")) && warnings.some((w) => w.msg === "webhook.on_inbound_failed"));
      const relayed = mar.calls.find((c) => c.url.endsWith("/chat"))!.body as { message: string };
      const event = decodeEvent(relayed.message) as unknown as Record<string, unknown>;
      expect(JSON.stringify(event)).not.toContain("INJECTED");
      expect(JSON.stringify(event)).not.toContain("+19990000000");
      expect(JSON.stringify(event)).toContain("evt_async");
      expect(warnings.find((w) => w.msg === "webhook.on_inbound_failed")?.meta).toMatchObject({ userId: user.id, error: "async hook blew up" });
      expect(store.get(user.id)?.phone).toBe("+14155550123");
      // The server is still up after the rejection.
      expect((await fetch(`${base}/health`)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("checkAgentStatus: true holds a webhook for an old agent that is redeploying", async () => {
    const store = new UserStore(tempDir());
    const user = store.save(readyUser());
    const mar = fakeMaritime();
    mar.agentStatus["agt_42"] = "deploying";
    const server = createGateway({ store, publicUrl: "https://gw.example.com", maritime: { apiKey: "mk_test", baseUrl: "https://maritime.test", agentImage: "img:1" }, logger: silentLogger, fetchImpl: mar.fetch, checkAgentStatus: true });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const raw = JSON.stringify(imessageEvent("evt_redeploy", "conv_r"));
    expect((await fetch(`${base}/webhooks/inkbox/${user.id}`, { method: "POST", body: raw, headers: signHeaders(raw, user.signingKey) })).status).toBe(204);
    await new Promise((r) => setTimeout(r, 80));
    expect(mar.calls.filter((c) => c.url.endsWith("/chat"))).toHaveLength(0);
    expect(mar.calls.filter((c) => c.method === "GET" && c.url.endsWith("/api/agents/agt_42")).length).toBeGreaterThan(0);
    // The durable inbox keeps the event for a later retry instead of dropping it.
    const health = (await (await fetch(`${base}/health`)).json()) as { inbox: Record<string, number> };
    expect(Object.values(health.inbox).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("relays the Link OAuth callback to the user's agent as an envelope and shows a done page", async () => {
    const { base, store, mar } = await boot();
    store.save(readyUser({ id: "usr_link" }));
    const res = await fetch(`${base}/oauth/link/callback/usr_link?code=ac_123&state=st_abc`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Go back to your messages");
    expect(mar.calls).toHaveLength(1);
    expect(mar.calls[0]?.url).toBe("https://maritime.test/api/agents/agt_42/chat");
    const body = mar.calls[0]?.body as { message: string; conversation_id: string };
    expect(body.conversation_id).toBe("link:usr_link");
    expect(decodeEvent(body.message)).toMatchObject({ type: "link.oauth_callback", code: "ac_123", state: "st_abc" });

    expect((await fetch(`${base}/oauth/link/callback/usr_nobody?code=x&state=y`)).status).toBe(404);
    expect((await fetch(`${base}/oauth/link/callback/usr_link`)).status).toBe(400);

    // The single registered URI: the state's prefix is the agent's handle.
    const one = await fetch(`${base}/oauth/link/callback?code=ac_456&state=${encodeURIComponent(`${store.get("usr_link")!.handle}.st_xyz`)}`);
    expect(one.status).toBe(200);
    expect(mar.calls).toHaveLength(2);
    expect((mar.calls[1]?.body as { conversation_id: string }).conversation_id).toBe("link:usr_link");
    expect((await fetch(`${base}/oauth/link/callback?code=ac&state=nobody-here.st`)).status).toBe(404);

    // An agent that is not provisioned yet cannot take the code; the page says so.
    store.save(readyUser({ id: "usr_new", status: "provisioning", maritimeAgentId: undefined }));
    const early = await fetch(`${base}/oauth/link/callback/usr_new?code=ac&state=st`);
    expect(early.status).toBe(502);
    expect(await early.text()).toContain("Not connected");
  });

  it("returns json 404 for unknown routes and html 404 for unknown connect ids", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const connect = await fetch(`${base}/connect/usr_missing`);
    expect(connect.status).toBe(404);
    expect(await connect.text()).toContain("No Instinct with that id");
  });
});

describe("admin desktop api", () => {
  function patch(base: string, token: string | undefined, userId: string, body: unknown = { enabled: true }) {
    return fetch(`${base}/api/admin/desktop/${userId}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  it("answers 503 while the admin token is not configured", async () => {
    const { base } = await boot({ seed: [readyUser()] });
    const res = await patch(base, "whatever", "usr_test");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not configured/);
  });

  it("rejects a bad bearer token with 401 before touching anything", async () => {
    const { base, mar } = await boot({ seed: [readyUser()], adminToken: "adm_secret" });
    const res = await patch(base, "wrong", "usr_test");
    expect(res.status).toBe(401);
    expect(mar.calls).toHaveLength(0);
  });

  it("patches the agent's desktop-config and returns Maritime's answer", async () => {
    const { base, mar } = await boot({ seed: [readyUser()], adminToken: "adm_secret" });
    mar.queue.push({ body: { enabled: true, status: "ok" } });
    const res = await patch(base, "adm_secret", "usr_test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, desktop: { enabled: true, status: "ok" } });
    const call = mar.calls.find((c) => c.method === "PATCH");
    expect(call?.url).toBe("https://maritime.test/api/agents/agt_42/desktop-config");
    expect(call?.body).toEqual({ enabled: true });
  });

  it("maps unknown users, unready agents and bad bodies", async () => {
    const { base } = await boot({ seed: [readyUser({ maritimeAgentId: undefined })], adminToken: "adm_secret" });
    expect((await patch(base, "adm_secret", "usr_missing")).status).toBe(404);
    expect((await patch(base, "adm_secret", "usr_test")).status).toBe(409);

    const ready = await boot({ seed: [readyUser()], adminToken: "adm_secret" });
    expect((await patch(ready.base, "adm_secret", "usr_test", { enabled: "yes" })).status).toBe(400);
    expect((await patch(ready.base, "adm_secret", "usr_test", {})).status).toBe(400);
  });

  it("passes Maritime's own constraint errors through", async () => {
    const { base, mar } = await boot({ seed: [readyUser()], adminToken: "adm_secret" });
    mar.queue.push(402);
    const res = await patch(base, "adm_secret", "usr_test");
    expect(res.status).toBe(402);
  });
});

describe("admin reprovision api", () => {
  function repro(base: string, token: string | undefined, userId: string) {
    return fetch(`${base}/api/admin/reprovision/${userId}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  }

  it("answers 503 while the admin token is not configured", async () => {
    const { base } = await boot({ seed: [readyUser()] });
    expect((await repro(base, "whatever", "usr_test")).status).toBe(503);
  });

  it("rejects a bad bearer token with 401 before touching anything", async () => {
    const { base, mar } = await boot({ seed: [readyUser()], adminToken: "adm_secret" });
    expect((await repro(base, "wrong", "usr_test")).status).toBe(401);
    expect(mar.calls).toHaveLength(0);
  });

  it("404s an unknown user and 409s an agent that is not provisioned", async () => {
    const { base } = await boot({ seed: [readyUser({ maritimeAgentId: undefined })], adminToken: "adm_secret" });
    expect((await repro(base, "adm_secret", "usr_missing")).status).toBe(404);
    expect((await repro(base, "adm_secret", "usr_test")).status).toBe(409);
  });

  it("recomputes env and pushes the delta without recreating the agent", async () => {
    const { base, mar } = await boot({ seed: [readyUser()], adminToken: "adm_secret" });
    mar.env["agt_42"] = [{ key: "PORT", value: String(MARITIME_AGENT_PORT) }];
    const res = await repro(base, "adm_secret", "usr_test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.synced).toBeGreaterThan(0);
    // It pushed env, never a create/identity call.
    expect(mar.calls.some((c) => c.method === "POST" && c.url.endsWith("/env"))).toBe(true);
    expect(mar.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/agents"))).toBe(false);
  });
});

describe("connect brain form", () => {
  function saveBrain(base: string, userId: string, fields: Record<string, string>) {
    return fetch(`${base}/connect/${userId}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });
  }

  it("saves a repo with a token, keeps the token on re-save, and clears on empty", async () => {
    const { base, store } = await boot({ seed: [readyUser()] });
    const id = "usr_test";

    const first = await saveBrain(base, id, { brainRepo: "https://github.com/acme/handbook", brainToken: "ghp_abcdefgh123456" });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe(`/connect/${id}`);
    expect(store.get(id)).toMatchObject({ brainRepo: "acme/handbook", brainToken: "ghp_abcdefgh123456" });

    // Re-saving the repo with an empty token box must not lose the saved token.
    const second = await saveBrain(base, id, { brainRepo: "acme/notes" });
    expect(second.status).toBe(303);
    expect(store.get(id)).toMatchObject({ brainRepo: "acme/notes", brainToken: "ghp_abcdefgh123456" });

    const page = await (await fetch(`${base}/connect/${id}`)).text();
    expect(page).toContain("acme/notes");
    expect(page).not.toContain("ghp_abcdefgh123456");

    const invalid = await saveBrain(base, id, { brainRepo: "not-a-repo" });
    expect(invalid.status).toBe(400);
    expect(store.get(id)?.brainRepo).toBe("acme/notes");

    const cleared = await saveBrain(base, id, { brainRepo: "" });
    expect(cleared.status).toBe(303);
    expect(store.get(id)?.brainRepo).toBeUndefined();
    expect(store.get(id)?.brainToken).toBeUndefined();
  });

  it("answers JSON clients with JSON", async () => {
    const { base, store } = await boot({ seed: [readyUser()] });
    const res = await fetch(`${base}/connect/usr_test`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ brainRepo: "acme/handbook" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hasBrain: true, hasPostizKey: false });
    expect(store.get("usr_test")?.brainRepo).toBe("acme/handbook");
  });

  it("saves a Postiz key, keeps it on empty, and clears it via the checkbox", async () => {
    const { base, store } = await boot({ seed: [readyUser()] });
    const id = "usr_test";

    const saved = await saveBrain(base, id, { brainRepo: "acme/handbook", postizKey: "pk_abcdefgh1234" });
    expect(saved.status).toBe(303);
    expect(store.get(id)?.postizKey).toBe("pk_abcdefgh1234");

    // The key is a secret: never on the page, never in the JSON.
    const page = await (await fetch(`${base}/connect/${id}`)).text();
    expect(page).toContain("Postiz key saved");
    expect(page).not.toContain("pk_abcdefgh1234");
    expect(page).toContain('name="postizClear"');

    // Re-saving the brain with an empty Postiz box must not lose the key.
    const kept = await saveBrain(base, id, { brainRepo: "acme/handbook" });
    expect(kept.status).toBe(303);
    expect(store.get(id)?.postizKey).toBe("pk_abcdefgh1234");

    const cleared = await saveBrain(base, id, { brainRepo: "acme/handbook", postizClear: "on" });
    expect(cleared.status).toBe(303);
    expect(store.get(id)?.postizKey).toBeUndefined();
  });

  it("rejects an invalid Postiz key without touching the saved one", async () => {
    const { base, store } = await boot({ seed: [readyUser({ postizKey: "pk_abcdefgh" })] });
    const invalid = await saveBrain(base, "usr_test", { brainRepo: "acme/handbook", postizKey: "short" });
    expect(invalid.status).toBe(400);
    expect(store.get("usr_test")?.postizKey).toBe("pk_abcdefgh");
  });

  it("mints a Postiz connected account in the background when the key is saved", async () => {
    const minted: Array<{ handle: string; toolkit?: string }> = [];
    const composio = {
      postizReady: true,
      ensureAccount: async (handle: string, opts: { toolkit?: string } = {}) => {
        minted.push({ handle, toolkit: opts.toolkit });
        return "pca_1";
      },
    } as unknown as ComposioPlatform;
    const { base, store } = await boot({ seed: [readyUser()], composio });
    const res = await saveBrain(base, "usr_test", { brainRepo: "", postizKey: "pk_abcdefgh1234" });
    expect(res.status).toBe(303);
    await waitFor(() => minted.length === 1);
    expect(minted[0]).toMatchObject({ handle: "maria", toolkit: "CUSTOM_POSTIZ" });
    expect(store.get("usr_test")?.postizComposioAccountId).toBe("pca_1");
  });

  it("404s an unknown connect id", async () => {
    const { base } = await boot();
    expect((await saveBrain(base, "usr_missing", { brainRepo: "acme/handbook" })).status).toBe(404);
  });

  it("kicks off a GitHub push in the background without holding the response", async () => {
    const { base, mar } = await boot({ seed: [readyUser()] });
    const res = await saveBrain(base, "usr_test", { brainRepo: "acme/handbook" });
    expect(res.status).toBe(303);
    const until = Date.now() + 2000;
    while (Date.now() < until && !mar.calls.some((c) => c.url.includes("api.github.com/repos/acme/handbook"))) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(mar.calls.some((c) => c.url.includes("api.github.com/repos/acme/handbook"))).toBe(true);
  });

  it("stores a brain from signup and exposes hasBrain without leaking the token", async () => {
    const { base, store } = await boot();
    const res = await signup(base, {
      name: "Maria",
      phone: "415 555 0123",
      handle: "maria",
      brainRepo: "acme/handbook",
      brainToken: "ghp_abcdefgh123456",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { userId: string };
    expect(store.get(body.userId)).toMatchObject({ brainRepo: "acme/handbook", brainToken: "ghp_abcdefgh123456" });
    const pub = (await (await fetch(`${base}/api/users/${body.userId}`)).json()) as Record<string, unknown>;
    expect(pub["hasBrain"]).toBe(true);
    expect(pub["brainToken"]).toBeUndefined();
    expect(pub["brainRepo"]).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain("ghp_");
  });

  it("never echoes the GitHub token back into a failed signup form", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "Maria",
        phone: "415 555 0123",
        handle: "maria",
        brainRepo: "not-a-repo",
        brainToken: "ghp_abcdefgh123456",
      }).toString(),
    });
    expect(res.status).toBe(400);
    const page = await res.text();
    expect(page).toContain("owner/repo");
    expect(page).not.toContain("ghp_abcdefgh123456");
  });
});

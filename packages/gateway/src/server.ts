import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { InkboxProvisioner } from "@open-instinct/inkbox";
import { DurableInbox, RetryAfterError } from "@open-instinct/inkbox";
import { join } from "node:path";
import { type SignupLimits, SlidingWindowLimiter, clientAddress, pendingCount, signupLimits } from "./limits.js";
import { type Logger, consoleLogger } from "./logger.js";
import { GITHUB_URL, type RouterInfo, connectRouterFor, renderConnect, renderLanding, renderLinkDone, renderMessage, renderPending } from "./pages.js";
import { type LinkPassthrough, type MaritimeProvisionOptions, newUserId, provisionUser } from "./provision.js";
import { EventDeduper, type HeaderMap, relayVerifiedEvent, relayGatewayEvent, verifyForUser } from "./relay.js";
import { type UserRecord, type UserStore, publicUser } from "./store.js";
import { validateSignup } from "./validate.js";

export interface GatewayOptions {
  store: UserStore;
  publicUrl: string;
  /** Without a provisioner the gateway only relays; signup is disabled. */
  inkbox?: InkboxProvisioner;
  inkboxBaseUrl?: string;
  maritime: MaritimeProvisionOptions;
  signupSecret?: string;
  anthropicApiKey?: string;
  composioApiKey?: string;
  /** Comma-separated Composio toolkits sent with the key. Default gmail,googlecalendar,googlecontacts. */
  composioToolkits?: string;
  /** Stripe Link credentials copied into every agent, with the redirect URI pointing at this gateway. */
  link?: LinkPassthrough;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  /** Router info cache lifetime. Default 10 minutes. */
  routerCacheMs?: number;
  /** Max webhook body size in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  now?: () => number;
  /** Per-address and global signup caps. Defaults in limits.ts. */
  signupLimits?: Partial<SignupLimits>;
  /** Count signups by X-Forwarded-For instead of the socket address. Only behind a proxy you control. */
  trustProxy?: boolean;
  /**
   * Router info scoped to one user (an identity-key call to Inkbox's triage
   * endpoint). Its QR is shown only when it names the user's handle. Without
   * this the connect page shows the number and the `sms:` button, no QR.
   */
  routerInfoFor?: (user: UserRecord) => Promise<RouterInfo | undefined>;
  /**
   * Called when a signup names a phone that already has an Instinct. The
   * response to the caller is neutral; this is the operator's chance to send
   * the connect link to the phone itself.
   */
  notifyExisting?: (user: UserRecord, connectUrl: string) => Promise<void>;
  /**
   * Renders the one-line pages people see at the end of a flow that lands on the gateway
   * (the Link wallet callback, a lost connect page). A front door with its own brand passes
   * its page renderer; the default is the gateway's own look.
   */
  renderPage?: (title: string, text: string, status: "ok" | "error") => string;
  /**
   * Called with every verified, parsed inbound event before it is queued for the
   * agent. A front door can learn the sender's phone from the first message or
   * keep counters. It gets a deep copy, so it cannot change what is relayed. A throw
   * or a rejected promise is logged and never blocks or crashes the relay; the hook
   * is not awaited.
   */
  onInbound?: (user: UserRecord, event: Record<string, unknown>) => void | Promise<void>;
  /** Ask Maritime for the agent's state before every relay (true), never (false), or only for agents under 15 minutes old (default). */
  checkAgentStatus?: boolean;
}

export interface GatewayServer extends Server {
  /** Restart provisioning for every record left in "provisioning" by an earlier process. Returns how many. */
  resumePending(): number;
  /**
   * Add any webhook event the gateway now needs (see DEFAULT_WEBHOOK_EVENTS) to the
   * subscription of every ready user, so identities provisioned before an event existed
   * (call.ended) receive it. Best effort, one user at a time; a failure is logged and
   * skipped. Returns how many subscriptions gained an event.
   */
  backfillWebhookEvents(): Promise<number>;
  /** Stop admission work and wait for forwarding requests already in flight. */
  drainWebhooks(): Promise<void>;
}

const JSON_TYPE = "application/json; charset=utf-8";
const HTML_TYPE = "text/html; charset=utf-8";

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

const json = (res: ServerResponse, status: number, value: unknown) => send(res, status, JSON_TYPE, JSON.stringify(value));
const html = (res: ServerResponse, status: number, page: string) => send(res, status, HTML_TYPE, page);

type InboxPayload = { userId: string; identityId: string; event: Record<string, unknown> } &
  ({ kind?: "webhook" } | { kind: "gateway"; conversationId: string });

function parseBody(raw: Buffer, contentType: string | undefined): Record<string, unknown> {
  const text = raw.toString("utf8");
  if (!text.trim()) return {};
  if (contentType?.includes("application/json")) {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "body must be a JSON object");
    return parsed as Record<string, unknown>;
  }
  return Object.fromEntries(new URLSearchParams(text).entries());
}

function wantsJson(req: IncomingMessage): boolean {
  const ct = req.headers["content-type"] ?? "";
  const accept = req.headers["accept"] ?? "";
  return ct.includes("application/json") || (accept.includes("application/json") && !accept.includes("text/html"));
}

export function createGateway(opts: GatewayOptions): GatewayServer {
  const log = opts.logger ?? consoleLogger;
  const now = opts.now ?? Date.now;
  const dedupe = new EventDeduper(5000);
  const routerCacheMs = opts.routerCacheMs ?? 10 * 60_000;
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  const limits = signupLimits(opts.signupLimits);
  const ipLimiter = new SlidingWindowLimiter(limits.perIp, limits.windowMs, now);
  let routerCache: { at: number; value: RouterInfo } | undefined;
  const perUserRouter = new Map<string, { at: number; value: RouterInfo }>();
  const inFlight = new Set<string>();

  const relayDeps = {
    maritime: { apiKey: opts.maritime.apiKey, baseUrl: opts.maritime.baseUrl },
    fetchImpl: opts.fetchImpl,
    logger: log,
    dedupe,
    ...(opts.checkAgentStatus !== undefined ? { checkAgentStatus: opts.checkAgentStatus } : {}),
  };
  const inbox = new DurableInbox<InboxPayload>({
    file: join(opts.store.dir, "webhook-inbox.json"),
    now,
    replayRunning: true,
    handle: async (payload) => {
      const user = opts.store.get(payload.userId);
      if (!user || user.identityId !== payload.identityId) {
        const error = new Error("Webhook identity is no longer assigned to this user");
        error.name = "InboundUncertainError";
        throw error;
      }
      if (!user.maritimeAgentId) throw new Error("Agent is not ready");
      const result = payload.kind === "gateway"
        ? await relayGatewayEvent(user, payload.event, payload.conversationId, relayDeps)
        : await relayVerifiedEvent(user, payload.event, relayDeps);
      if (result.status === "rejected") {
        const reason = result.reason ?? "Forwarding failed";
        if (result.retryAfterMs !== undefined) throw new RetryAfterError(reason, result.retryAfterMs);
        throw new Error(reason);
      }
    },
    onError: (id, status) => log.warn("relay.pending", { id, status }),
  });

  async function routerInfo(): Promise<RouterInfo | undefined> {
    if (!opts.inkbox) return undefined;
    if (routerCache && now() - routerCache.at < routerCacheMs) return routerCache.value;
    try {
      const value = await opts.inkbox.routerInfo();
      routerCache = { at: now(), value };
      return value;
    } catch (err) {
      log.warn("router_info.failed", { error: err instanceof Error ? err.message : String(err) });
      return routerCache?.value;
    }
  }

  async function routerInfoForUser(user: UserRecord): Promise<RouterInfo | undefined> {
    if (!opts.routerInfoFor || !user.identityApiKey) return undefined;
    const cached = perUserRouter.get(user.id);
    if (cached && now() - cached.at < routerCacheMs) return cached.value;
    try {
      const value = await opts.routerInfoFor(user);
      if (value) perUserRouter.set(user.id, { at: now(), value });
      return value;
    } catch (err) {
      log.warn("router_info.user_failed", { userId: user.id, error: err instanceof Error ? err.message : String(err) });
      return cached?.value;
    }
  }

  function startProvisioning(user: UserRecord): void {
    if (!opts.inkbox || inFlight.has(user.id)) return;
    inFlight.add(user.id);
    provisionUser(user, {
      inkbox: opts.inkbox,
      inkboxBaseUrl: opts.inkboxBaseUrl,
      maritime: opts.maritime,
      publicUrl: opts.publicUrl,
      store: opts.store,
      anthropicApiKey: opts.anthropicApiKey,
      composioApiKey: opts.composioApiKey,
      composioToolkits: opts.composioToolkits,
      link: opts.link,
      fetchImpl: opts.fetchImpl,
      logger: log,
      userId: user.id,
    })
      .catch(() => undefined)
      .finally(() => inFlight.delete(user.id));
  }

  function resumePending(): number {
    if (!opts.inkbox) return 0;
    let n = 0;
    for (const u of opts.store.all()) {
      if (u.status !== "provisioning") continue;
      startProvisioning(u);
      n++;
    }
    if (n > 0) log.info("provision.resumed", { count: n });
    return n;
  }

  async function backfillWebhookEvents(): Promise<number> {
    if (!opts.inkbox) return 0;
    let n = 0;
    for (const u of opts.store.all()) {
      if (u.status !== "ready" || !u.webhookSubscriptionId) continue;
      try {
        const added = await opts.inkbox.ensureWebhookEvents(u.webhookSubscriptionId);
        if (added.length > 0) {
          n++;
          log.info("provision.webhook_events_added", { userId: u.id, subscriptionId: u.webhookSubscriptionId, added });
        }
      } catch (err) {
        log.warn("provision.webhook_events_failed", { userId: u.id, subscriptionId: u.webhookSubscriptionId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return n;
  }

  function connectUrl(userId: string): string {
    return `${opts.publicUrl.replace(/\/+$/, "")}/connect/${encodeURIComponent(userId)}`;
  }

  /** Same body for "this phone already has an Instinct" and "you asked again": nothing to learn. */
  async function respondPending(req: IncomingMessage, res: ServerResponse, handle: string): Promise<void> {
    if (wantsJson(req)) return json(res, 202, { status: "pending" });
    const shared = await routerInfo();
    return html(res, 202, renderPending(handle, connectRouterFor(handle, shared, undefined)));
  }

  async function handleSignup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const asJson = wantsJson(req);
    if (!opts.inkbox) {
      if (asJson) return json(res, 503, { error: "signup disabled on this gateway" });
      return html(res, 503, renderMessage("Signups are closed", "This gateway only relays messages.", "error"));
    }
    const body = parseBody(await readBody(req, 64 * 1024), req.headers["content-type"]);
    const check = validateSignup(body, { signupSecret: opts.signupSecret });
    if (!check.ok) {
      if (asJson) return json(res, 400, { error: "invalid signup", errors: check.errors });
      const values = Object.fromEntries(Object.entries(body).filter(([k, v]) => k !== "inviteCode" && typeof v === "string")) as Record<string, string>;
      return html(res, 400, renderLanding({ signupEnabled: true, requireInvite: Boolean(opts.signupSecret), errors: check.errors, values }));
    }
    const { value } = check;

    const address = clientAddress(req, opts.trustProxy === true);
    if (!ipLimiter.allow(address)) {
      log.warn("signup.rate_limited", { reason: "per address" });
      if (asJson) return json(res, 429, { error: "too many signups from this address; try again later" });
      return html(res, 429, renderMessage("Slow down", "Too many signups from this address. Try again in a few minutes.", "error"));
    }

    const byHandle = opts.store.byHandle(value.handle);
    const byPhone = opts.store.byPhone(value.phone);
    if (byHandle && byHandle.phone === value.phone) {
      // Same person again: a retry after an error, a crash mid-provision, or a lost connect page.
      if (byHandle.status !== "ready") startProvisioning(byHandle);
      void opts.notifyExisting?.(byHandle, connectUrl(byHandle.id)).catch((err: unknown) => log.warn("notify.failed", { userId: byHandle.id, error: String(err) }));
      return respondPending(req, res, value.handle);
    }
    if (byHandle) {
      // Only invitees learn that a handle exists; the open form gets a generic answer.
      if (opts.signupSecret) {
        if (asJson) return json(res, 409, { error: "handle taken", errors: { handle: "That handle is taken." } });
        return html(res, 409, renderLanding({ signupEnabled: true, requireInvite: true, errors: { handle: "That handle is taken." }, values: { ...value } }));
      }
      if (asJson) return json(res, 400, { error: "could not create" });
      return html(res, 400, renderLanding({ signupEnabled: true, requireInvite: false, errors: { form: "Could not create an Instinct with these details. Try different ones." }, values: { ...value } }));
    }
    if (byPhone) {
      void opts.notifyExisting?.(byPhone, connectUrl(byPhone.id)).catch((err: unknown) => log.warn("notify.failed", { userId: byPhone.id, error: String(err) }));
      return respondPending(req, res, value.handle);
    }

    const pending = pendingCount(opts.store.all(), now(), limits.pendingWindowMs);
    if (pending >= limits.maxPending) {
      log.warn("signup.rate_limited", { reason: "pending cap", pending });
      if (asJson) return json(res, 429, { error: "signups are paused for a moment; try again later" });
      return html(res, 429, renderMessage("Busy", "Many people are signing up right now. Try again in an hour.", "error"));
    }

    const user = opts.store.save({
      id: newUserId(),
      name: value.name,
      phone: value.phone,
      ...(value.email ? { email: value.email } : {}),
      handle: value.handle,
      identityId: "",
      identityApiKey: "",
      signingKey: "",
      createdAt: new Date(now()).toISOString(),
      status: "provisioning",
    });
    log.info("signup.created", { userId: user.id, handle: user.handle });
    startProvisioning(user);

    if (asJson) return json(res, 202, { userId: user.id, connectUrl: connectUrl(user.id), status: user.status });
    res.writeHead(303, { Location: `/connect/${encodeURIComponent(user.id)}` });
    res.end();
  }

  async function handleWebhook(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
    const user = opts.store.get(userId);
    if (!user) return json(res, 404, { error: "unknown user" });
    const raw = await readBody(req, maxBody);
    const headers = req.headers as HeaderMap;
    if (!verifyForUser(raw, headers, user)) {
      log.warn("webhook.unauthorized", { userId });
      return json(res, 401, { error: "invalid signature" });
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      if (!event || typeof event !== "object" || typeof event.id !== "string" || !event.id) throw new Error("invalid event");
    } catch {
      return json(res, 400, { error: "expected a webhook event with an id" });
    }
    if (opts.onInbound) {
      const hookFailed = (err: unknown) => log.warn("webhook.on_inbound_failed", { userId, error: err instanceof Error ? err.message : String(err) });
      try {
        const pending = opts.onInbound(structuredClone(user), structuredClone(event));
        if (pending && typeof (pending as Promise<void>).then === "function") (pending as Promise<void>).then(undefined, hookFailed);
      } catch (err) {
        hookFailed(err);
      }
    }
    inbox.enqueue(`${user.id}:${event.id}`, { userId: user.id, identityId: user.identityId, event });
    res.writeHead(204);
    res.end();
  }

  /** Link sends the browser here after approval. The code goes to the agent, which holds the PKCE verifier. */
  const page = opts.renderPage ?? renderMessage;
  const linkDone = (ok: boolean): string =>
    opts.renderPage
      ? ok
        ? opts.renderPage("Connected", "Your wallet is on its way to your agent. Go back to your messages; it will confirm there.", "ok")
        : opts.renderPage("Not connected", "The wallet connection could not be handed to your agent right now. Ask it to try again from your messages.", "error")
      : renderLinkDone(ok);

  async function handleLinkCallback(res: ServerResponse, userId: string, query: URLSearchParams): Promise<void> {
    const user = opts.store.get(userId);
    if (!user) return html(res, 404, page("Not found", "No agent with that id.", "error"));
    const code = query.get("code") ?? "";
    const state = query.get("state") ?? "";
    const error = query.get("error") ?? undefined;
    if (!code && !error) throw new HttpError(400, "missing code");
    const event: Record<string, unknown> = { type: "link.oauth_callback", code, state, receivedAt: new Date(now()).toISOString() };
    if (error) event["error"] = error;
    const result = await relayGatewayEvent(user, event, `link:${user.id}`, relayDeps);
    if (result.retryAfterMs !== undefined) {
      const digest = createHash("sha256").update(JSON.stringify([user.id, code, state, error])).digest("hex");
      inbox.enqueue(`link:${user.id}:${digest}`, {
        kind: "gateway", userId: user.id, identityId: user.identityId, event, conversationId: `link:${user.id}`,
      }, result.retryAfterMs);
      log.info("link.callback", { userId: user.id, status: "queued", reason: result.reason });
      return html(res, 200, linkDone(true));
    }
    log.info("link.callback", { userId: user.id, status: result.status, reason: result.reason });
    return html(res, result.status === "forwarded" ? 200 : 502, linkDone(result.status === "forwarded"));
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    if (parts.length === 0) {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
      return html(res, 200, renderLanding({ signupEnabled: Boolean(opts.inkbox), requireInvite: Boolean(opts.signupSecret) }));
    }
    if (parts[0] === "health" && parts.length === 1) {
      return json(res, 200, { ok: true, users: opts.store.all().length, signup: Boolean(opts.inkbox), github: GITHUB_URL, inbox: inbox.summary() });
    }
    if (parts[0] === "api" && parts[1] === "signup" && parts.length === 2) {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      return handleSignup(req, res);
    }
    if (parts[0] === "api" && parts[1] === "users" && parts.length === 3) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const user = opts.store.get(decodeURIComponent(parts[2] ?? ""));
      if (!user) throw new HttpError(404, "unknown user");
      return json(res, 200, { ...publicUser(user), connectUrl: connectUrl(user.id) });
    }
    if (parts[0] === "connect" && parts.length === 2) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const user = opts.store.get(decodeURIComponent(parts[1] ?? ""));
      if (!user) return html(res, 404, renderMessage("Not found", "No Instinct with that id. Check the link you were given.", "error"));
      const [shared, perUser] = await Promise.all([routerInfo(), routerInfoForUser(user)]);
      return html(res, 200, renderConnect(user, connectRouterFor(user.handle, shared, perUser)));
    }
    if (parts[0] === "webhooks" && parts[1] === "inkbox" && parts.length === 3) {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      return handleWebhook(req, res, decodeURIComponent(parts[2] ?? ""));
    }
    if (parts[0] === "oauth" && parts[1] === "link" && parts[2] === "callback" && parts.length === 4) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return handleLinkCallback(res, decodeURIComponent(parts[3] ?? ""), url.searchParams);
    }
    if (parts[0] === "oauth" && parts[1] === "link" && parts[2] === "callback" && parts.length === 3) {
      // One registered redirect URI for the whole fleet: the agent put its handle in front of the
      // OAuth state (`<handle>.<random>`), so the callback finds the user from there.
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const handle = (url.searchParams.get("state") ?? "").split(".")[0] ?? "";
      const user = handle ? opts.store.byHandle(handle) : undefined;
      if (!user) return html(res, 404, page("Not found", "This link does not belong to an agent here. Start the connection again from your agent.", "error"));
      return handleLinkCallback(res, user.id, url.searchParams);
    }
    throw new HttpError(404, "not found");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : "internal error";
      if (status >= 500) log.error("request.failed", { path: req.url?.split("?")[0], error: err instanceof Error ? err.message : String(err) });
      if (res.headersSent) return res.end();
      json(res, status, { error: message });
    });
  });
  server.on("listening", () => inbox.start());
  server.on("close", () => inbox.stop());
  return Object.assign(server, { resumePending, backfillWebhookEvents, drainWebhooks: () => inbox.close() });
}

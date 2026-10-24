import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { InkboxProvisioner } from "@open-instinct/inkbox";
import { DurableInbox } from "@open-instinct/inkbox";
import { join } from "node:path";
import { type SignupLimits, SlidingWindowLimiter, clientAddress, pendingCount, signupLimits } from "./limits.js";
import { type Logger, consoleLogger } from "./logger.js";
import { GITHUB_URL, type RouterInfo, connectRouterFor, renderConnect, renderLanding, renderLinkDone, renderMessage, renderPending } from "./pages.js";
import { MaritimeApiError, type LinkPassthrough, type MaritimeProvisionOptions, healOxygenAccount, healPostizAccount, maritimeRequest, newUserId, provisionUser, syncAgentEnv } from "./provision.js";
import { OXYGEN_TOOLKIT_NAME, POSTIZ_TOOLKIT_SLUG, type ComposioPlatform } from "./composio.js";
import { pushBrain } from "./brain.js";
import { EventDeduper, type HeaderMap, relayVerifiedEvent, relayGatewayEvent, verifyForUser } from "./relay.js";
import { type UserRecord, type UserStore, publicUser } from "./store.js";
import { loadTemplateRegistry } from "./templates.js";
import { parseBrainUpdate, parsePostizKeyUpdate, secretMatches, validateSignup } from "./validate.js";

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
  /**
   * Built executor toolkit platform. Its presence marks the executor as
   * configured: provisioning connects one account per person (user_id = handle)
   * and only configured gateways keep `custom_executor` in a template's list.
   */
  composio?: ComposioPlatform;
  /** Fleet-wide GitHub token: fallback for brain pushes when the person supplied none. */
  githubToken?: string;
  /**
   * Bearer token for the admin API (POST /api/admin/desktop/<userId>).
   * Unset disables the endpoint with 503 — the desktop toggle never ships open.
   */
  adminToken?: string;
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
  /** Directory holding registry/, personas/ and skills/. Default: the templates shipped with the package. */
  templateDir?: string;
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
  const templates = loadTemplateRegistry(opts.templateDir);
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
  const inbox = new DurableInbox<{ userId: string; identityId: string; event: Record<string, unknown> }>({
    file: join(opts.store.dir, "webhook-inbox.json"),
    replayRunning: true,
    handle: async ({ userId, identityId, event }) => {
      const user = opts.store.get(userId);
      if (!user || user.identityId !== identityId) {
        const error = new Error("Webhook identity is no longer assigned to this user");
        error.name = "InboundUncertainError";
        throw error;
      }
      if (!user.maritimeAgentId) throw new Error("Agent is not ready");
      const result = await relayVerifiedEvent(user, event, relayDeps);
      if (result.status === "rejected") throw new Error(result.reason ?? "Forwarding failed");
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
      composio: opts.composio,
      githubToken: opts.githubToken,
      link: opts.link,
      template: templates.get(user.templateId),
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

  /**
   * Reply when handle+phone both match an existing record: a retry, a crash mid-provision,
   * or a lost connect page. Only ever reached for the caller's own signup, so the JSON body
   * carries that record's identity (the deploy edge function attaches it to its own row)
   * while nothing about anyone else's record is revealed.
   */
  async function respondPending(req: IncomingMessage, res: ServerResponse, user: UserRecord): Promise<void> {
    if (wantsJson(req)) {
      return json(res, 202, {
        status: "pending",
        userId: user.id,
        connectUrl: connectUrl(user.id),
        handle: user.handle,
        templateId: user.templateId,
        templateName: templates.get(user.templateId)?.title ?? null,
      });
    }
    const shared = await routerInfo();
    return html(res, 202, renderPending(user.handle, connectRouterFor(user.handle, shared, undefined)));
  }

  async function handleSignup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const asJson = wantsJson(req);
    if (!opts.inkbox) {
      if (asJson) return json(res, 503, { error: "signup disabled on this gateway" });
      return html(res, 503, renderMessage("Signups are closed", "This gateway only relays messages.", "error"));
    }
    const body = parseBody(await readBody(req, 64 * 1024), req.headers["content-type"]);
    const check = validateSignup(body, { signupSecret: opts.signupSecret, knownTemplates: templates.ids() });
    // The token is a secret: never echoed back into a rendered form, whatever the outcome.
    const echoValues = <T extends object>(v: T): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === "string" && k !== "inviteCode" && k !== "brainToken" && k !== "brain_token" && k !== "postizKey" && k !== "postiz_key") out[k] = val;
      }
      return out;
    };
    if (!check.ok) {
      if (asJson) return json(res, 400, { error: "invalid signup", errors: check.errors });
      return html(res, 400, renderLanding({ signupEnabled: true, requireInvite: Boolean(opts.signupSecret), errors: check.errors, values: echoValues(body) }));
    }
    const { value } = check;

    const address = clientAddress(req, opts.trustProxy === true);
    if (!ipLimiter.allow(address)) {
      log.warn("signup.rate_limited", { reason: "per address" });
      if (asJson) return json(res, 429, { error: "too many signups from this address; try again later" });
      return html(res, 429, renderMessage("Slow down", "Too many signups from this address. Try again in a few minutes.", "error"));
    }

    // Reuse only ever keys on handle AND phone together: the same person re-submitting
    // their own details lands on their record, while a fresh handle is a fresh agent —
    // one owner phone can run a fleet (each platform deploy derives a new handle).
    const byHandle = opts.store.byHandle(value.handle);
    if (byHandle && byHandle.phone === value.phone) {
      // Same person again: a retry after an error, a crash mid-provision, or a lost connect page.
      // Runs for a ready record too — provisionUser's ready branch only re-syncs
      // env and re-mints a missing Postiz connection; nothing is recreated.
      startProvisioning(byHandle);
      void opts.notifyExisting?.(byHandle, connectUrl(byHandle.id)).catch((err: unknown) => log.warn("notify.failed", { userId: byHandle.id, error: String(err) }));
      return respondPending(req, res, byHandle);
    }
    if (byHandle) {
      // Only invitees learn that a handle exists; the open form gets a generic answer.
      if (opts.signupSecret) {
        if (asJson) return json(res, 409, { error: "handle taken", errors: { handle: "That handle is taken." } });
        return html(res, 409, renderLanding({ signupEnabled: true, requireInvite: true, errors: { handle: "That handle is taken." }, values: echoValues(value) }));
      }
      if (asJson) return json(res, 400, { error: "could not create" });
      return html(res, 400, renderLanding({ signupEnabled: true, requireInvite: false, errors: { form: "Could not create an Instinct with these details. Try different ones." }, values: echoValues(value) }));
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
      ...(value.brainRepo ? { brainRepo: value.brainRepo } : {}),
      ...(value.brainToken ? { brainToken: value.brainToken } : {}),
      handle: value.handle,
      templateId: value.templateId,
      identityId: "",
      identityApiKey: "",
      signingKey: "",
      createdAt: new Date(now()).toISOString(),
      status: "provisioning",
    });
    log.info("signup.created", { userId: user.id, handle: user.handle, templateId: user.templateId });
    startProvisioning(user);

    if (asJson) {
      return json(res, 202, {
        userId: user.id,
        connectUrl: connectUrl(user.id),
        status: user.status,
        templateId: user.templateId,
        templateName: templates.get(user.templateId)?.title ?? null,
      });
    }
    res.writeHead(303, { Location: `/connect/${encodeURIComponent(user.id)}` });
    res.end();
  }

  /**
   * POST /api/admin/desktop/<userId> {"enabled": true|false}
   * Desktop seat toggles for one agent, bearer-protected by GATEWAY_ADMIN_TOKEN.
   * 503 while unset (endpoint off), 401 on a bad token, 404 unknown user.
   * Maritime's own constraints (seat cap 402, floor 409/422) pass through as-is.
   */
  async function handleAdminDesktop(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
    if (!opts.adminToken) return json(res, 503, { error: "admin api is not configured" });
    const auth = typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!secretMatches(token, opts.adminToken)) {
      log.warn("admin.unauthorized", { path: req.url });
      return json(res, 401, { error: "unauthorized" });
    }
    const user = opts.store.get(userId);
    if (!user) return json(res, 404, { error: "unknown user" });
    if (!user.maritimeAgentId) return json(res, 409, { error: "agent is not ready yet" });
    const body = parseBody(await readBody(req, 8 * 1024), req.headers["content-type"]);
    const enabled = body["enabled"];
    if (typeof enabled !== "boolean") return json(res, 400, { error: "enabled must be a boolean" });
    try {
      const desktop = await maritimeRequest(
        { maritime: opts.maritime, fetchImpl: opts.fetchImpl },
        "PATCH",
        `/api/agents/${encodeURIComponent(user.maritimeAgentId)}/desktop-config`,
        { enabled },
      );
      log.info("admin.desktop", { userId: user.id, enabled });
      return json(res, 200, { ok: true, desktop: desktop ?? { enabled } });
    } catch (err) {
      if (err instanceof MaritimeApiError) return json(res, err.status, { error: err.detail });
      throw err;
    }
  }

  /**
   * Full env-sync dependency set (template, readiness flags, secrets) for one
   * person — used by the admin reprovision endpoint and the Oxygen callback.
   */
  function envSyncDeps(user: UserRecord) {
    return {
      inkboxBaseUrl: opts.inkboxBaseUrl,
      maritime: opts.maritime,
      publicUrl: opts.publicUrl,
      anthropicApiKey: opts.anthropicApiKey,
      composioApiKey: opts.composioApiKey,
      composioToolkits: opts.composioToolkits,
      composio: opts.composio,
      link: opts.link,
      template: templates.get(user.templateId),
      fetchImpl: opts.fetchImpl,
      logger: log,
    };
  }

  /**
   * POST /api/admin/reprovision/<userId>
   * Recompute an agent's env from its template + current readiness, push only
   * the differing keys to Maritime, and bounce the agent's container
   * (stop → start) so the store's env is actually applied — store writes
   * alone never reach an already-deployed container. The agent keeps its id,
   * identity and connected accounts — nothing is recreated. Bearer-protected
   * by GATEWAY_ADMIN_TOKEN; 503 while unset, 401 on a bad token, 404 unknown
   * user.
   */
  async function handleAdminReprovision(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
    if (!opts.adminToken) return json(res, 503, { error: "admin api is not configured" });
    const auth = typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!secretMatches(token, opts.adminToken)) {
      log.warn("admin.unauthorized", { path: req.url });
      return json(res, 401, { error: "unauthorized" });
    }
    const user = opts.store.get(userId);
    if (!user) return json(res, 404, { error: "unknown user" });
    if (!user.maritimeAgentId) return json(res, 409, { error: "agent is not provisioned yet" });
    try {
      // Heal first: both heals can add a toolkit to the env (custom_oxygen via
      // its account id), so syncing before them would push a stale list.
      const healedPostiz = await healPostizAccount(user, { composio: opts.composio }, opts.store, log);
      const healed = await healOxygenAccount(healedPostiz, { composio: opts.composio }, opts.store, log);
      const result = await syncAgentEnv(healed, envSyncDeps(healed));
      const summary = {
        postizAccountId: healed.postizComposioAccountId ?? null,
        oxygenAccountId: healed.oxygenComposioAccountId ?? null,
      };
      log.info("admin.reprovision", { userId: user.id, ...result, ...summary });
      return json(res, 200, { ok: true, ...result, ...summary });
    } catch (err) {
      if (err instanceof MaritimeApiError) return json(res, err.status, { error: err.detail });
      throw err;
    }
  }

  /**
   * DELETE /api/admin/users/<userId>
   * Full teardown of one person: best-effort Inkbox identity delete (a 404
   * counts as already gone), best-effort Maritime agent delete (same), then
   * drop the record from the store. The store removal is authoritative — a
   * downstream hiccup is reported in the body, never fatal. Bearer-protected
   * by GATEWAY_ADMIN_TOKEN; 503 while unset, 401 on a bad token, 404 unknown
   * user. The Inkbox identity delete is what keeps the fleet's identity cap
   * free; skipping it would leak a mailbox/number per deleted agent.
   */
  async function handleAdminDeleteUser(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
    if (!opts.adminToken) return json(res, 503, { error: "admin api is not configured" });
    const auth = typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!secretMatches(token, opts.adminToken)) {
      log.warn("admin.unauthorized", { path: req.url });
      return json(res, 401, { error: "unauthorized" });
    }
    const user = opts.store.get(userId);
    if (!user) return json(res, 404, { error: "unknown user" });

    // Best-effort Inkbox teardown. deleteIdentity already treats 404 as done
    // (mailbox + number + tunnel cascade); anything else is reported, not fatal.
    let identityDeleted = false;
    let identityError: string | null = null;
    if (opts.inkbox) {
      try {
        await opts.inkbox.deleteIdentity(user.handle);
        identityDeleted = true;
      } catch (err) {
        identityError = err instanceof Error ? err.message : String(err);
        log.warn("admin.delete.inkbox_failed", { userId: user.id, handle: user.handle, error: identityError });
      }
    }

    // Best-effort Maritime teardown: a 404 means the agent is already gone,
    // which is success. The caller is deleting the person, not negotiating.
    let agentDeleted = false;
    let agentError: string | null = null;
    if (user.maritimeAgentId) {
      try {
        await maritimeRequest(
          { maritime: opts.maritime, fetchImpl: opts.fetchImpl },
          "DELETE",
          `/api/agents/${encodeURIComponent(user.maritimeAgentId)}`,
        );
        agentDeleted = true;
      } catch (err) {
        if (err instanceof MaritimeApiError && err.status === 404) {
          agentDeleted = true; // already gone — best-effort success
        } else {
          agentError = err instanceof Error ? err.message : String(err);
          log.warn("admin.delete.maritime_failed", { userId: user.id, agentId: user.maritimeAgentId, error: agentError });
        }
      }
    }

    const removed = opts.store.remove(user.id);
    log.info("admin.delete", { userId: user.id, handle: user.handle, identityDeleted, agentDeleted, removed });
    return json(res, 200, { ok: true, removed, identityDeleted, agentDeleted, identityError, agentError });
  }

  /**
   * POST /connect/<userId> — the connect page's connections form (brain + Postiz).
   * Empty repo clears the brain (and its token); an empty token or Postiz key
   * keeps the saved one; the Postiz checkbox removes it. The brain push and the
   * Postiz account mint run fire-and-forget (a slow GitHub walk must not hold
   * the page), and the stored record changes first, so a retry is safe.
   */
  async function handleConnectUpdate(req: IncomingMessage, res: ServerResponse, user: UserRecord): Promise<void> {
    const body = parseBody(await readBody(req, 32 * 1024), req.headers["content-type"]);
    const check = parseBrainUpdate(body);
    const postiz = parsePostizKeyUpdate(body);
    const fail = (errors: Record<string, string>): void => {
      if (wantsJson(req)) return json(res, 400, { error: "invalid connections", errors });
      return html(res, 400, renderMessage("Check the form", Object.values(errors).join(" "), "error"));
    };
    if (!check.ok) return fail(check.errors);
    if (!postiz.ok) return fail(postiz.errors);
    const { repo, token } = check.value;

    let next: UserRecord = { ...user };
    if (!repo) {
      delete next.brainRepo;
      delete next.brainToken;
      log.info("connect.brain_cleared", { userId: user.id });
    } else {
      next.brainRepo = repo;
      if (token) next.brainToken = token;
      // Never log the token — only the repo, which is not secret.
      log.info("connect.brain_saved", { userId: user.id, repo, replacedToken: Boolean(token) });
    }
    // The Postiz key is a secret: never logged, never echoed back.
    if (postiz.value.clear) {
      delete next.postizKey;
      delete next.postizComposioAccountId;
      log.info("connect.postiz_key_cleared", { userId: user.id });
    } else if (postiz.value.key) {
      next.postizKey = postiz.value.key;
      // A new key means the old connection no longer matches; re-mint below.
      delete next.postizComposioAccountId;
      log.info("connect.postiz_key_saved", { userId: user.id });
    }
    next = opts.store.save(next);

    if (repo && next.maritimeAgentId) {
      const agentId = next.maritimeAgentId;
      void pushBrain(repo, next.brainToken, {
        fetchImpl: opts.fetchImpl,
        githubToken: opts.githubToken,
        logger: log,
        write: async (path, content) => {
          await maritimeRequest({ maritime: opts.maritime, fetchImpl: opts.fetchImpl }, "PUT", `/api/agents/${encodeURIComponent(agentId)}/files/write`, { path, content });
        },
      })
        .then((r) => log.info("connect.brain_pushed", { userId: user.id, repo, ...r }))
        .catch((err: unknown) => log.warn("connect.brain_failed", { userId: user.id, repo, error: err instanceof Error ? err.message : String(err) }));
    }
    // Mint the Postiz connected account carrying this person's own key.
    if (postiz.value.key && !postiz.value.clear && opts.composio?.postizReady) {
      const key = postiz.value.key;
      const handle = next.handle;
      void opts.composio
        .ensureAccount(handle, { toolkit: POSTIZ_TOOLKIT_SLUG, apiKey: key })
        .then((accountId) => {
          const u = opts.store.get(next.id);
          if (u && u.postizComposioAccountId !== accountId) opts.store.save({ ...u, postizComposioAccountId: accountId });
          log.info("connect.postiz_account", { userId: next.id, accountId });
        })
        .catch((err: unknown) => log.warn("connect.postiz_account_failed", { userId: next.id, error: err instanceof Error ? err.message : String(err) }));
    }

    if (wantsJson(req)) return json(res, 200, { ok: true, hasBrain: Boolean(next.brainRepo), hasPostizKey: Boolean(next.postizKey) });
    res.writeHead(303, { Location: `/connect/${encodeURIComponent(user.id)}` });
    res.end();
  }

  /**
   * GET /connect/<userId>/oxygen — start the per-person Oxygen OAuth dance.
   * Creates the connected account (INITIATED) and Composio's hosted link,
   * records the pending account id, and sends the browser to the link; the
   * person approves there (Clerk at the toolkit's issuer) and Composio returns
   * them to the OAuth callback below.
   */
  async function handleOxygenConnect(res: ServerResponse, userId: string): Promise<void> {
    const user = opts.store.get(userId);
    if (!user) return html(res, 404, renderMessage("Not found", "No Instinct with that id. Check the link you were given.", "error"));
    if (!opts.composio?.oxygenReady) {
      return html(res, 503, renderMessage("Oxygen not ready", "The Oxygen connection cannot start right now. Try again in a minute.", "error"));
    }
    try {
      const callbackUrl = `${opts.publicUrl.replace(/\/+$/, "")}/oauth/composio/callback?user=${encodeURIComponent(user.id)}`;
      const { redirectUrl, accountId } = await opts.composio.initiateOxygenLink(user.handle, callbackUrl);
      opts.store.save({ ...user, oxygenPendingAccountId: accountId });
      log.info("connect.oxygen_initiated", { userId: user.id, accountId });
      res.writeHead(302, { Location: redirectUrl });
      res.end();
    } catch (err) {
      log.warn("connect.oxygen_initiate_failed", { userId: user.id, error: err instanceof Error ? err.message : String(err) });
      return html(res, 502, renderMessage("Could not start Oxygen", "Composio did not hand back a connection link. Go back and try once more.", "error"));
    }
  }

  /**
   * GET /oauth/composio/callback?user=<id>[&connectedAccountId=…][&error=…]
   * Composio returns the browser here after the Oxygen OAuth dance. Verify the
   * account — ACTIVE, owned by this person's handle, toolkit custom_oxygen —
   * polling briefly because the redirect can land before the token exchange
   * finishes; then save it, clear the pending id and re-sync the agent's env so
   * custom_oxygen enters its toolkit list. Any mismatch changes nothing and
   * says so; a failure is logged with what Composio actually reported.
   */
  async function handleOxygenCallback(res: ServerResponse, query: URLSearchParams): Promise<void> {
    const user = opts.store.get(query.get("user") ?? "");
    if (!user) {
      return html(res, 404, renderMessage("Not found", "This link does not belong to an agent here. Start the connection again from your connect page.", "error"));
    }
    const error = query.get("error_description") ?? query.get("error");
    if (error) {
      return html(res, 200, renderMessage("Oxygen not connected", `Composio returned: ${error}. Nothing was changed — start again from your connect page.`, "error"));
    }
    const candidate = query.get("connectedAccountId") || user.oxygenPendingAccountId || "";
    if (!candidate || !opts.composio) {
      return html(res, 200, renderMessage("Oxygen not connected", "There is no connection to verify yet. Start again from your connect page.", "error"));
    }
    let info: { status: string; userId: string; toolkit: string } | undefined;
    for (let i = 0; i < 10; i += 1) {
      try {
        info = await opts.composio.connectedAccountInfo(candidate);
        if (info.status === "ACTIVE") break;
      } catch {
        info = undefined; // not visible yet
      }
      if (i < 9) await new Promise((r) => setTimeout(r, 1000));
    }
    if (info && info.status === "ACTIVE" && info.userId === user.handle && info.toolkit === OXYGEN_TOOLKIT_NAME) {
      const next: UserRecord = { ...user, oxygenComposioAccountId: candidate };
      delete next.oxygenPendingAccountId;
      const saved = opts.store.save(next);
      log.info("connect.oxygen_connected", { userId: saved.id, accountId: candidate });
      void syncAgentEnv(saved, envSyncDeps(saved)).catch((err: unknown) =>
        log.warn("connect.oxygen_env_sync_failed", { userId: saved.id, error: err instanceof Error ? err.message : String(err) }),
      );
      res.writeHead(303, { Location: `/connect/${encodeURIComponent(saved.id)}` });
      res.end();
      return;
    }
    log.warn("connect.oxygen_verify_failed", {
      userId: user.id,
      accountId: candidate,
      status: info?.status ?? "not_found",
      owner: info?.userId ?? "",
      toolkit: info?.toolkit ?? "",
    });
    return html(
      res,
      200,
      renderMessage("Oxygen not connected", "Composio did not report an active connection. Nothing was changed — start again from your connect page.", "error"),
    );
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
      return json(res, 200, {
        ok: true,
        users: opts.store.all().length,
        signup: Boolean(opts.inkbox),
        github: GITHUB_URL,
        inbox: inbox.summary(),
        templates: templates.ids(),
      });
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
    if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "desktop" && parts.length === 4) {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      return handleAdminDesktop(req, res, decodeURIComponent(parts[3] ?? ""));
    }
    if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "reprovision" && parts.length === 4) {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      return handleAdminReprovision(req, res, decodeURIComponent(parts[3] ?? ""));
    }
    if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "users" && parts.length === 4) {
      if (method !== "DELETE") throw new HttpError(405, "method not allowed");
      return handleAdminDeleteUser(req, res, decodeURIComponent(parts[3] ?? ""));
    }
    if (parts[0] === "connect" && parts.length === 3 && parts[2] === "oxygen") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return handleOxygenConnect(res, decodeURIComponent(parts[1] ?? ""));
    }
    if (parts[0] === "connect" && parts.length === 2) {
      const user = opts.store.get(decodeURIComponent(parts[1] ?? ""));
      if (!user) return html(res, 404, renderMessage("Not found", "No Instinct with that id. Check the link you were given.", "error"));
      if (method === "POST") return handleConnectUpdate(req, res, user);
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      // Visiting the page heals a completed-but-uncaptured Oxygen dance (the
      // browser callback can fail on Composio's side while the account is
      // already ACTIVE), so the page shows Connected and the env follows.
      let current = user;
      if (opts.composio?.oxygenReady && !current.oxygenComposioAccountId && current.oxygenPendingAccountId) {
        const healed = await healOxygenAccount(current, { composio: opts.composio }, opts.store, log);
        if (healed.oxygenComposioAccountId) {
          current = healed;
          void syncAgentEnv(current, envSyncDeps(current)).catch((err: unknown) =>
            log.warn("connect.oxygen_env_sync_failed", { userId: current.id, error: err instanceof Error ? err.message : String(err) }),
          );
        }
      }
      const [shared, perUser] = await Promise.all([routerInfo(), routerInfoForUser(current)]);
      return html(res, 200, renderConnect(current, connectRouterFor(current.handle, shared, perUser), Boolean(opts.composio?.oxygenReady)));
    }
    if (parts[0] === "webhooks" && parts[1] === "inkbox" && parts.length === 3) {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      return handleWebhook(req, res, decodeURIComponent(parts[2] ?? ""));
    }
    if (parts[0] === "oauth" && parts[1] === "composio" && parts[2] === "callback") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return handleOxygenCallback(res, url.searchParams);
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
      if (status >= 500) log.error("request.failed", { path: req.url, error: err instanceof Error ? err.message : String(err) });
      if (res.headersSent) return res.end();
      json(res, status, { error: message });
    });
  });
  server.on("listening", () => inbox.start());
  server.on("close", () => inbox.stop());
  return Object.assign(server, { resumePending, backfillWebhookEvents, drainWebhooks: () => inbox.close() });
}

import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InkboxProvisioner } from "@open-instinct/inkbox";
import type { UserRecord } from "../src/store.js";

export function tempDir(prefix = "gateway-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function signHeaders(rawBody: Buffer | string, signingKey: string, opts: { requestId?: string; timestamp?: number } = {}): Record<string, string> {
  const requestId = opts.requestId ?? "req_1";
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const key = signingKey.startsWith("whsec_") ? signingKey.slice(6) : signingKey;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
  const sig = createHmac("sha256", key).update(Buffer.concat([Buffer.from(`${requestId}.${timestamp}.`), body])).digest("hex");
  return {
    "x-inkbox-request-id": requestId,
    "x-inkbox-timestamp": timestamp,
    "x-inkbox-signature": `sha256=${sig}`,
    "content-type": "application/json",
  };
}

export function readyUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "usr_test",
    name: "Maria",
    phone: "+14155550123",
    email: "maria@example.com",
    handle: "maria",
    identityId: "idn_1",
    identityApiKey: "ik_secret",
    signingKey: "whsec_topsecret",
    maritimeAgentId: "agt_42",
    createdAt: "2026-10-03T00:00:00.000Z",
    status: "ready",
    ...overrides,
  };
}

export function imessageEvent(id = "evt_1", conversationId = "conv_9"): Record<string, unknown> {
  return {
    id,
    event_type: "imessage.received",
    timestamp: "2026-10-03T12:00:00Z",
    data: {
      message: { id: "msg_1", conversation_id: conversationId, remote_number: "+14155550123", content: "hi", is_group: false, participants: [], media: [] },
      contacts: [],
      agent_identities: [],
    },
  };
}

export interface FakeInkbox {
  calls: string[];
  provisioner: InkboxProvisioner;
  fail: Partial<Record<"provisionIdentity" | "mintIdentityKey" | "ensureSigningKey" | "subscribeWebhooks" | "ensureWebhookEvents", number>>;
}

/** A provisioner whose methods record their order and can be told to fail n times. */
export function fakeInkbox(opts: { subscriptionSigningKey?: string } = {}): FakeInkbox {
  const calls: string[] = [];
  const fail: FakeInkbox["fail"] = {};
  const maybeFail = (name: keyof FakeInkbox["fail"]) => {
    const n = fail[name] ?? 0;
    if (n > 0) {
      fail[name] = n - 1;
      throw new Error(`${name} failed`);
    }
  };
  const provisioner = {
    async provisionIdentity(input: { handle: string }) {
      calls.push("provisionIdentity");
      maybeFail("provisionIdentity");
      return { identityId: `idn_${input.handle}`, handle: input.handle, email: `${input.handle}@inkbox.ai`, imessageEnabled: true };
    },
    async mintIdentityKey(identityId: string) {
      calls.push("mintIdentityKey");
      maybeFail("mintIdentityKey");
      return `ik_${identityId}`;
    },
    async ensureSigningKey(handle: string) {
      calls.push("ensureSigningKey");
      maybeFail("ensureSigningKey");
      return `whsec_${handle}`;
    },
    async subscribeWebhooks(identityId: string, url: string) {
      calls.push(`subscribeWebhooks ${url}`);
      maybeFail("subscribeWebhooks");
      return { subscriptionId: `sub_${identityId}`, signingKey: opts.subscriptionSigningKey };
    },
    // The org-wide triage endpoint answers with a placeholder handle, never the user's own.
    async routerInfo() {
      calls.push("routerInfo");
      return { number: "+14155550199", connectCommand: "connect @handle", smsLink: "sms:+14155550199&body=connect%20%40handle", qrPngDataUrl: "data:image/png;base64,iVBORw0KGgo=" };
    },
    async enableA2A() {},
    async addContactRule() {},
    async createInvitation() {
      return { id: "inv_1" };
    },
    async deleteIdentity() {},
    // Every subscription is missing call.ended, as one made before the event existed would be.
    async ensureWebhookEvents(subscriptionId: string) {
      calls.push(`ensureWebhookEvents ${subscriptionId}`);
      maybeFail("ensureWebhookEvents");
      return ["call.ended"];
    },
  } as unknown as InkboxProvisioner;
  return { calls, provisioner, fail };
}

export interface FakeMaritime {
  calls: Array<{ method: string; url: string; body?: unknown; headers: Record<string, string> }>;
  fetch: typeof fetch;
  /** Status codes to answer in order before falling back to success. */
  queue: Array<number | Error | { body: unknown }>;
  existingAgents: Array<{ id: string; externalId: string; projectId?: string }>;
  /** Status answered for GET /api/agents/<id>; ids not listed answer 404. */
  agentStatus: Record<string, string>;
  /** Env rows per agent id, backing GET/POST /api/agents/<id>/env. */
  env: Record<string, Array<{ key: string; value: string; isSecret?: boolean }>>;
}

export function fakeMaritime(): FakeMaritime {
  const state: FakeMaritime = { calls: [], queue: [], existingAgents: [], agentStatus: {}, env: {}, fetch: undefined as unknown as typeof fetch };
  state.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    state.calls.push({ method, url, body, headers });
    const next = state.queue.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "number") return new Response(JSON.stringify({ detail: `status ${next}` }), { status: next });
    if (next && typeof next === "object") return new Response(JSON.stringify(next.body), { status: 200 });
    if (method === "GET" && /\/api\/agents\/[^/?]+$/.test(url)) {
      const id = decodeURIComponent(url.split("/").pop() ?? "");
      const status = state.agentStatus[id];
      return status ? new Response(JSON.stringify({ id, status }), { status: 200 }) : new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
    }
    if (method === "GET" && url.includes("/api/agents?externalId=")) {
      const ext = decodeURIComponent(url.split("externalId=")[1] ?? "");
      return new Response(JSON.stringify(state.existingAgents.filter((a) => a.externalId === ext)), { status: 200 });
    }
    if (method === "POST" && url.endsWith("/api/agents")) {
      const agent = { id: `agt_${state.calls.length}`, externalId: String(body.externalId), projectId: "prj_1" };
      state.existingAgents.push(agent);
      return new Response(JSON.stringify(agent), { status: 201 });
    }
    if (method === "POST" && url.includes("/chat")) return new Response(JSON.stringify({ response: "ok" }), { status: 200 });
    const envMatch = url.match(/\/api\/agents\/([^/?]+)\/env$/);
    if (envMatch) {
      const agentId = decodeURIComponent(envMatch[1] ?? "");
      const rows = (state.env[agentId] ??= []);
      if (method === "GET") return new Response(JSON.stringify(rows), { status: 200 });
      if (method === "POST" && body) {
        const existing = rows.find((r) => r.key === body.key);
        if (existing) existing.value = body.value;
        else rows.push({ key: body.key, value: body.value, isSecret: body.isSecret });
        return new Response(JSON.stringify({ key: body.key, value: body.value, isSecret: body.isSecret }), { status: 201 });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return state;
}

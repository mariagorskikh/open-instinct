import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGateway } from "../src/server.js";
import { UserStore } from "../src/store.js";
import { silentLogger } from "../src/logger.js";
import { fakeMaritime, imessageEvent, readyUser, signHeaders, tempDir } from "./helpers.js";

const servers: ReturnType<typeof createGateway>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });
async function serve(store: UserStore, fetchImpl: typeof fetch, now?: () => number) {
  const server = createGateway({ store, fetchImpl, now, logger: silentLogger, publicUrl: "https://gateway.example.com", maritime: { apiKey: "test", agentImage: "test" } });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("webhook recovery", () => {
  it("keeps an acknowledged event after all forwarding attempts fail", async () => {
    const store = new UserStore(tempDir());
    const user = store.save(readyUser());
    let calls = 0;
    const base = await serve(store, async () => { calls++; return new Response("{}", { status: 503 }); });
    const raw = JSON.stringify(imessageEvent());
    const res = await fetch(`${base}/webhooks/inkbox/${user.id}`, { method: "POST", body: raw, headers: signHeaders(raw, user.signingKey) });
    expect(res.status).toBe(204);
    const receipts = () => JSON.parse(readFileSync(join(store.dir, "webhook-inbox.json"), "utf8")).receipts;
    expect(receipts()[0].payload.event.id).toBe("evt_1");
    await vi.waitFor(() => expect(calls).toBe(3), { timeout: 4000 });
    await vi.waitFor(() => expect(receipts()[0].status).toBe("queued"));
    expect(receipts()[0].payload.event.id).toBe("evt_1");
  });

  it("saves Maritime's long Retry-After on the webhook receipt", async () => {
    const store = new UserStore(tempDir());
    const user = store.save(readyUser());
    let calls = 0;
    const sentAt = 1_700_000_000_000;
    const base = await serve(store, async () => {
      calls++;
      return new Response("{}", { status: 429, headers: { "Retry-After": "30" } });
    }, () => sentAt);
    const raw = JSON.stringify(imessageEvent("evt_rate_limited"));
    const res = await fetch(`${base}/webhooks/inkbox/${user.id}`, {
      method: "POST", body: raw, headers: signHeaders(raw, user.signingKey),
    });
    expect(res.status).toBe(204);
    const receipt = () => JSON.parse(readFileSync(join(store.dir, "webhook-inbox.json"), "utf8")).receipts[0];
    await vi.waitFor(() => expect(receipt()).toMatchObject({ status: "queued", attempts: 1 }));
    expect(receipt().payload.event.id).toBe("evt_rate_limited");
    expect(receipt().nextAttemptAt).toBe(sentAt + 30_000);
    expect(calls).toBe(1);
  });

  it("replays stored admission after restart without rechecking expired request headers", async () => {
    const store = new UserStore(tempDir());
    const user = store.save(readyUser());
    const event = imessageEvent("stored-event");
    writeFileSync(join(store.dir, "webhook-inbox.json"), JSON.stringify({ version: 1, receipts: [{ id: `${user.id}:stored-event`, status: "queued", attempts: 1, nextAttemptAt: 0, payload: { userId: user.id, identityId: user.identityId, event } }] }));
    const upstream = fakeMaritime();
    await serve(store, upstream.fetch);
    await vi.waitFor(() => expect(upstream.calls).toHaveLength(1));
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(store.dir, "webhook-inbox.json"), "utf8")).receipts[0].status).toBe("done"));
  });

  it("does not forward an event to a reassigned identity", async () => {
    const store = new UserStore(tempDir());
    const user = store.save(readyUser());
    writeFileSync(join(store.dir, "webhook-inbox.json"), JSON.stringify({ version: 1, receipts: [{ id: "old-event", status: "queued", attempts: 0, nextAttemptAt: 0, payload: { userId: user.id, identityId: "previous-identity", event: imessageEvent() } }] }));
    const upstream = fakeMaritime();
    await serve(store, upstream.fetch);
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(store.dir, "webhook-inbox.json"), "utf8")).receipts[0].status).toBe("uncertain"));
    expect(upstream.calls).toHaveLength(0);
  });
});

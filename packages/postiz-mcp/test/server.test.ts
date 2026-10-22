import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { createPostizMcpServer } from "../src/main.js";

const servers: Server[] = [];

async function startServer(fetchImpl?: typeof fetch): Promise<string> {
  const server = createPostizMcpServer({ postizApiUrl: "https://postiz.test/api", ...(fetchImpl ? { fetchImpl } : {}) });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

let rpcId = 0;
function rpc(method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) });
}

async function post(baseUrl: string, body: string, authorization?: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(authorization ? { Authorization: authorization } : {}) },
    body,
  });
}

describe("postiz-mcp HTTP server", () => {
  it("serves health without auth", async () => {
    const base = await startServer();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("401s /mcp without a key and 405s GET /mcp (stateless)", async () => {
    const base = await startServer();
    const unauth = await post(base, rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
    expect(unauth.status).toBe(401);
    const get = await fetch(`${base}/mcp`);
    expect(get.status).toBe(405);
    const missing404 = await fetch(`${base}/nope`);
    expect(missing404.status).toBe(404);
  });

  it("completes initialize, lists tools, and calls a tool against a stubbed Postiz", async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      expect(String(url)).toBe("https://postiz.test/api/public/v1/integrations");
      return new Response(JSON.stringify([{ id: "int_1", identifier: "x", name: "Account" }]), { status: 200 });
    };
    const base = await startServer(fetchImpl as typeof fetch);

    const init = await post(base, rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "composio", version: "1" } }), "Bearer pk_e2e");
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
    expect(initBody.result.serverInfo.name).toBe("postiz-mcp");

    const listed = await post(base, rpc("tools/list"), "Bearer pk_e2e");
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listBody.result.tools.map((t) => t.name)).toContain("create_post");

    const called = await post(base, rpc("tools/call", { name: "list_integrations", arguments: {} }), "Bearer pk_e2e");
    expect(called.status).toBe(200);
    const callBody = (await called.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(callBody.result.isError).toBeFalsy();
    expect(JSON.parse(callBody.result.content[0]!.text)).toEqual([{ id: "int_1", identifier: "x", name: "Account" }]);
  });

  it("keeps each request's key isolated (stateless: no session bleed)", async () => {
    const seen: string[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push((init?.headers as Record<string, string>)["Authorization"] ?? "");
      return new Response("[]", { status: 200 });
    };
    const base = await startServer(fetchImpl as typeof fetch);
    await post(base, rpc("tools/call", { name: "list_integrations", arguments: {} }), "Bearer pk_alice");
    await post(base, rpc("tools/call", { name: "list_integrations", arguments: {} }), "Bearer pk_bob");
    expect(seen).toEqual(["pk_alice", "pk_bob"]);
  });

  it("returns tool errors as isError results, not protocol failures", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("Rate limited", { status: 429 });
    const base = await startServer(fetchImpl as typeof fetch);
    const called = await post(base, rpc("tools/call", { name: "list_posts", arguments: {} }), "Bearer pk_x");
    expect(called.status).toBe(200);
    const body = (await called.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("429");
  });
});

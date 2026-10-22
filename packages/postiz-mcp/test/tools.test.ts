import { describe, expect, it } from "vitest";
import { PostizApiError, PostizClient } from "../src/postiz.js";
import { TOOLS, callTool } from "../src/tools.js";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function clientStub(handler: (req: Recorded) => { status?: number; json?: unknown } | Response): { client: PostizClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const record: Recorded = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(record);
    const out = handler(record);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out.json ?? {}), { status: out.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  return { client: new PostizClient({ baseUrl: "https://postiz.test/api/", apiKey: "pk_person", fetchImpl: fetchImpl as typeof fetch }), calls };
}

describe("PostizClient", () => {
  it("sends the raw key in Authorization with no Bearer prefix and joins the base URL", async () => {
    const { client, calls } = clientStub(() => ({ json: [] }));
    await client.request("GET", "/public/v1/integrations");
    expect(calls[0]?.url).toBe("https://postiz.test/api/public/v1/integrations");
    expect(calls[0]?.headers["Authorization"]).toBe("pk_person");
    expect(calls[0]?.headers["Authorization"]).not.toMatch(/Bearer/i);
  });

  it("raises PostizApiError with the response body on failure", async () => {
    const { client } = clientStub(() => new Response("No API Key found", { status: 401 }));
    await expect(client.request("GET", "/public/v1/integrations")).rejects.toMatchObject({ name: "PostizApiError", status: 401 });
    await expect(client.request("GET", "/public/v1/integrations")).rejects.toThrow(PostizApiError);
  });
});

describe("callTool", () => {
  it("lists integrations", async () => {
    const { client, calls } = clientStub(() => ({ json: [{ id: "int_1", identifier: "x" }] }));
    const result = await callTool(client, "list_integrations", {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual([{ id: "int_1", identifier: "x" }]);
    expect(calls[0]?.url).toContain("/public/v1/integrations");
  });

  it("creates a post, filling settings.__type from the integration's provider when omitted", async () => {
    const { client, calls } = clientStub((req) => {
      if (req.url.endsWith("/public/v1/integrations")) return { json: [{ id: "int_1", identifier: "bluesky" }] };
      return { json: [{ postId: "post_1", integration: "int_1" }] };
    });
    const result = await callTool(client, "create_post", {
      type: "schedule",
      date: "2026-10-22T10:00:00.000Z",
      posts: [{ integrationId: "int_1", content: "Hello world" }],
    });
    expect(result.isError).toBeUndefined();
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/public/v1/posts"));
    expect(create?.body).toMatchObject({
      type: "schedule",
      date: "2026-10-22T10:00:00.000Z",
      posts: [{ integration: { id: "int_1" }, value: [{ content: "Hello world", image: [] }], settings: { __type: "bluesky" } }],
    });
  });

  it("keeps explicit __type settings and forwards interval", async () => {
    const { client, calls } = clientStub(() => ({ json: [] }));
    await callTool(client, "create_post", {
      type: "now",
      interval: 60,
      posts: [
        { integrationId: "int_r", content: "a", settings: { __type: "reddit", subreddit: ["r/test"] } },
        { integrationId: "int_d", content: "b", settings: { __type: "discord", channel: "chan_1" } },
      ],
    });
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/public/v1/posts"));
    expect(create?.body).toMatchObject({
      type: "now",
      interval: 60,
      posts: [
        { integration: { id: "int_r" }, settings: { __type: "reddit", subreddit: ["r/test"] } },
        { integration: { id: "int_d" }, settings: { __type: "discord", channel: "chan_1" } },
      ],
    });
  });

  it("surfaces unknown integrations and API failures as tool errors, not crashes", async () => {
    const { client } = clientStub((req) => {
      if (req.url.endsWith("/public/v1/integrations")) return { json: [{ id: "int_other", identifier: "x" }] };
      return new Response("Integration not found", { status: 404 });
    });
    const missing = await callTool(client, "create_post", { type: "draft", posts: [{ integrationId: "int_gone", content: "x" }] });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("int_gone");

    const { client: failing } = clientStub(() => new Response("boom", { status: 500 }));
    const failed = await callTool(failing, "list_posts", {});
    expect(failed.isError).toBe(true);
    expect(failed.content[0]?.text).toContain("500");
  });

  it("deletes, updates status, fetches settings, uploads, and rejects unknown tools", async () => {
    const { client, calls } = clientStub(() => ({ json: { ok: true } }));
    await callTool(client, "delete_post", { id: "post_9" });
    expect(calls[0]).toMatchObject({ method: "DELETE" });
    expect(calls[0]?.url).toContain("/public/v1/posts/post_9");

    await callTool(client, "update_post_status", { id: "post_9", status: "draft" });
    expect(calls[1]).toMatchObject({ method: "PUT" });
    expect(calls[1]?.url).toContain("/public/v1/posts/post_9/status");
    expect(calls[1]?.body).toEqual({ status: "draft" });

    await callTool(client, "get_integration_settings", { id: "int_1" });
    expect(calls[2]?.url).toContain("/public/v1/integration-settings/int_1");

    await callTool(client, "upload_from_url", { url: "https://cdn.example/img.png" });
    expect(calls[3]).toMatchObject({ method: "POST" });
    expect(calls[3]?.url).toContain("/public/v1/upload-from-url");
    expect(calls[3]?.body).toEqual({ url: "https://cdn.example/img.png" });

    const unknown = await callTool(client, "nope", {});
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]?.text).toContain("unknown tool");
  });

  it("exposes exactly the documented tool surface", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "create_post",
      "delete_post",
      "get_integration_settings",
      "list_groups",
      "list_integrations",
      "list_posts",
      "update_post_status",
      "upload_from_url",
    ]);
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema["type"]).toBe("object");
    }
  });
});

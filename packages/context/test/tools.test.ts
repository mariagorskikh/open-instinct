import { describe, expect, it, vi } from "vitest";
import { contextTools } from "../src/index.js";

const ctx = {
  principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Owner" } as const,
  conversationKey: "chat:test",
  channel: "chat" as const,
  now: () => new Date("2026-10-07T00:00:00Z"),
};

function text(result: Awaited<ReturnType<(typeof contextTools)[number]["spec"]["execute"]>>): string {
  if (typeof result === "string") return result;
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

describe("contextTools", () => {
  it("sends a shaped Answers request and returns the answer with sources as untrusted web data", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ json_content: { answer: "Paris", population: 2_048_472 }, sources: ["https://example.com/paris"] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const [tool] = contextTools({ apiKey: "secret-key", fetchImpl, baseUrl: "https://api.example.test/v1/" });

    const result = await tool!.spec.execute(
      { task: "What is the population of Paris?", mode: "ultra", json_format: { answer: "", population: 0 } },
      ctx,
    );

    expect(tool!.spec.meta.capabilities).toEqual(["web.read"]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/v1/web/answers");
    expect(init.headers).toMatchObject({ Authorization: "Bearer secret-key", "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      task: "What is the population of Paris?",
      mode: "ultra",
      json_format: { answer: "", population: 0 },
    });
    expect(text(result)).toContain("Paris");
    expect(text(result)).toContain("https://example.com/paris");
    expect(text(result)).toContain('<untrusted source="Context.dev web answer">');
    expect(text(result)).not.toContain("secret-key");
  });

  it("defaults to fast mode and lets the API choose its standard answer shape", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ json_content: { answer: "Done" }, sources: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const [tool] = contextTools({ apiKey: "key", fetchImpl });

    await tool!.spec.execute({ task: "Read https://example.com" }, ctx);

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body).toEqual({ task: "Read https://example.com", mode: "fast" });
  });

  it("does not expose credentials or upstream response bodies on authentication errors", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "bad key secret-key" }), {
        status: 401,
        headers: { "x-request-id": "req_123" },
      }),
    );
    const [tool] = contextTools({ apiKey: "secret-key", fetchImpl });

    const result = await tool!.spec.execute({ task: "Latest news" }, ctx);

    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toBe("Context.dev request failed with HTTP 401. Request ID: req_123.");
    expect(text(result)).not.toContain("secret-key");
  });
});

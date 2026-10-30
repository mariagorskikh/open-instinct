import { describe, expect, it, vi } from "vitest";
import { keenableTools } from "../src/index.js";

const ctx = {
  principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Owner" } as const,
  conversationKey: "chat:test",
  channel: "chat" as const,
  now: () => new Date("2026-10-26T00:00:00Z"),
};

const publicLookup = async () => ["93.184.215.14"];

type Tool = ReturnType<typeof keenableTools>[number];

function text(result: Awaited<ReturnType<Tool["spec"]["execute"]>>): string {
  if (typeof result === "string") return result;
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tool(name: string, deps: Parameters<typeof keenableTools>[0]): Tool {
  const found = keenableTools({ lookup: publicLookup, ...deps }).find((t) => t.spec.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
}

describe("keenable_search", () => {
  it("calls the keyless endpoint with the app title and returns results as untrusted web data", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        results: [
          { title: "Paris", url: "https://example.com/paris", description: "", snippet: "Paris is the capital\n\nof France." },
          { title: "", url: "https://example.com/no-title", description: "", snippet: "" },
          { title: "No link", description: "", snippet: "dropped" },
        ],
      }),
    );
    const search = tool("keenable_search", { fetchImpl });

    const result = await search.spec.execute({ query: "capital of France" }, ctx);

    expect(search.spec.meta.capabilities).toEqual(["web.read"]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.keenable.ai/v1/search/public");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "X-Keenable-Title": "Open Instinct", "Content-Type": "application/json" });
    expect(init.headers).not.toHaveProperty("X-API-Key");
    expect(JSON.parse(init.body as string)).toEqual({ query: "capital of France", max_results: 8 });
    expect(text(result)).toContain('<untrusted source="Keenable search results for capital of France">');
    expect(text(result)).toContain("1. Paris\n   https://example.com/paris\n   Paris is the capital of France.");
    expect(text(result)).toContain("2. https://example.com/no-title\n   https://example.com/no-title");
    expect(text(result)).not.toContain("dropped");
  });

  it("uses the keyed endpoint when a key is set, passes site and published_after, and caps snippets", async () => {
    const fetchImpl = vi.fn(async () => json({ results: [{ title: "Long", url: "https://example.com/long", snippet: "x".repeat(5_000) }] }));
    const search = tool("keenable_search", { apiKey: "secret-key", fetchImpl, baseUrl: "https://api.example.test/v1/" });

    const result = await search.spec.execute({ query: "news", site: "example.com", published_after: "2026-10-01" }, ctx);

    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/v1/search");
    expect(init.headers).toMatchObject({ "X-API-Key": "secret-key", "X-Keenable-Title": "Open Instinct" });
    expect(JSON.parse(init.body as string)).toEqual({ query: "news", max_results: 8, site: "example.com", published_after: "2026-10-01" });
    expect(text(result)).toContain(`${"x".repeat(999)}…`);
    expect(text(result)).not.toContain("x".repeat(1_000));
    expect(text(result)).not.toContain("secret-key");
  });

  it("refuses a published_after that is not YYYY-MM-DD without calling Keenable", async () => {
    const fetchImpl = vi.fn(async () => json({ results: [] }));
    const search = tool("keenable_search", { fetchImpl });
    const result = await search.spec.execute({ query: "q", published_after: "last week" }, ctx);
    expect(result).toMatchObject({ isError: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a date-shaped published_after that names no real day", async () => {
    const fetchImpl = vi.fn(async () => json({ results: [] }));
    const search = tool("keenable_search", { fetchImpl });
    for (const published_after of ["2026-02-30", "2026-13-01", "2026-00-10"]) {
      expect(await search.spec.execute({ query: "q", published_after }, ctx)).toMatchObject({ isError: true });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    await search.spec.execute({ query: "q", published_after: "2024-02-29" }, ctx);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("says so when there are no results", async () => {
    const search = tool("keenable_search", { fetchImpl: vi.fn(async () => json({ results: [] })) });
    expect(text(await search.spec.execute({ query: "nothing here" }, ctx))).toBe('No results for "nothing here".');
  });

  it("points at KEENABLE_API_KEY on a keyless rate limit, and never echoes the key or the response body", async () => {
    const keyless = tool("keenable_search", { fetchImpl: vi.fn(async () => json({ error: "Too many requests" }, 429)) });
    const limited = await keyless.spec.execute({ query: "q" }, ctx);
    expect(limited).toMatchObject({ isError: true });
    expect(text(limited)).toContain("KEENABLE_API_KEY");

    const keyed = tool("keenable_search", { apiKey: "secret-key", fetchImpl: vi.fn(async () => json({ error: "bad key secret-key" }, 401)) });
    const rejected = await keyed.spec.execute({ query: "q" }, ctx);
    expect(rejected).toMatchObject({ isError: true });
    expect(text(rejected)).toBe("Keenable rejected the API key. The person running this agent must check KEENABLE_API_KEY.");
    expect(text(rejected)).not.toContain("secret-key");
  });

  it("returns an error result when Keenable cannot be reached", async () => {
    const search = tool("keenable_search", { fetchImpl: vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) });
    const result = await search.spec.execute({ query: "q" }, ctx);
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toBe("Could not reach Keenable.");
  });
});

describe("keenable_fetch", () => {
  it("fetches a public page as markdown through the keyless endpoint and wraps it as untrusted", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ url: "https://example.com/", title: "Example Domain", content: "This domain is for use in examples.", description: "" }),
    );
    const fetchTool = tool("keenable_fetch", { fetchImpl });

    const result = await fetchTool.spec.execute({ url: "https://example.com" }, ctx);

    expect(fetchTool.spec.meta.capabilities).toEqual(["web.read"]);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.keenable.ai/v1/fetch/public?url=https%3A%2F%2Fexample.com%2F");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ "X-Keenable-Title": "Open Instinct" });
    expect(text(result)).toContain('<untrusted source="web page example.com via Keenable">');
    expect(text(result)).toContain("# Example Domain\nhttps://example.com/\n\nThis domain is for use in examples.");
  });

  it("uses the keyed endpoint when a key is set and caps long pages", async () => {
    const fetchImpl = vi.fn(async () => json({ url: "https://example.com/long", title: "", content: "y".repeat(30_000) }));
    const fetchTool = tool("keenable_fetch", { apiKey: "secret-key", fetchImpl });

    const result = await fetchTool.spec.execute({ url: "https://example.com/long" }, ctx);

    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.keenable.ai/v1/fetch?url=https%3A%2F%2Fexample.com%2Flong");
    expect(init.headers).toMatchObject({ "X-API-Key": "secret-key" });
    expect(text(result)).toContain(`${"y".repeat(19_999)}…`);
    expect(text(result)).not.toContain("y".repeat(20_000));
  });

  it("refuses private, loopback and metadata targets without calling Keenable", async () => {
    const fetchImpl = vi.fn(async () => json({}));
    const fetchTool = tool("keenable_fetch", { fetchImpl, lookup: async () => ["10.0.0.5"] });

    for (const url of ["http://127.0.0.1:18789/schedules", "http://169.254.169.254/latest/meta-data", "http://localhost/", "https://intranet.example.com/", "file:///etc/passwd"]) {
      const result = await fetchTool.spec.execute({ url }, ctx);
      expect(result).toMatchObject({ isError: true });
      expect(text(result)).toContain(`Cannot fetch ${url}`);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports an unreachable page without the upstream body", async () => {
    const fetchTool = tool("keenable_fetch", { fetchImpl: vi.fn(async () => json({ error: "Bad gateway", message: "upstream fetch failed" }, 502)) });
    const result = await fetchTool.spec.execute({ url: "https://example.com/gone" }, ctx);
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toBe("Keenable request failed with HTTP 502.");
  });
});

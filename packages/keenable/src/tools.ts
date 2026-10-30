import { checkPublicTarget, defineTool, textResult, wrapUntrusted, type Lookup, type RegisteredTool, type ToolResultLike } from "@open-instinct/core";
import { Type } from "typebox";

const DEFAULT_BASE_URL = "https://api.keenable.ai/v1";
/** Keenable asks keyless callers to name their app; it is the only identifier sent. */
const APP_TITLE = "Open Instinct";
const REQUEST_TIMEOUT_MS = 30_000;
const SEARCH_RESULTS = 8;
/** Keenable snippets are raw page text of a few thousand characters; eight of them would crowd the context. */
const SNIPPET_CAP = 1_000;
const PAGE_TEXT_CAP = 20_000;

export interface KeenableToolDeps {
  /** Optional. Without it the tools call the keyless endpoints; a key only lifts the rate limits. */
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** DNS lookup used to vet keenable_fetch targets; tests inject a stub. */
  lookup?: Lookup;
}

interface KeenableSearchResult {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
}

interface KeenablePage {
  url?: unknown;
  title?: unknown;
  content?: unknown;
}

export function keenableTools(deps: KeenableToolDeps = {}): RegisteredTool[] {
  return [keenableSearchTool(deps), keenableFetchTool(deps)];
}

function keenableSearchTool({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch }: KeenableToolDeps): RegisteredTool {
  return defineTool({
    name: "keenable_search",
    label: "Keenable web search",
    description:
      "Search the web through Keenable and return the top results with titles, links and page text. Optionally limit results to one domain with site, or to pages published after a date with published_after.",
    parameters: Type.Object({
      query: Type.String(),
      site: Type.Optional(Type.String({ description: "One domain to search within, for example example.com." })),
      published_after: Type.Optional(Type.String({ description: "Only pages published after this date, YYYY-MM-DD." })),
    }),
    meta: { capabilities: ["web.read"], group: "web", describe: (args) => `search ${argText(args, "query")}` },
    execute: async ({ query, site, published_after }, _ctx, signal) => {
      if (published_after && !isCalendarDate(published_after)) return failedResult("published_after must be a real date in the form YYYY-MM-DD.");
      const body = {
        query,
        max_results: SEARCH_RESULTS,
        ...(site ? { site } : {}),
        ...(published_after ? { published_after } : {}),
      };
      let response: Response;
      try {
        response = await fetchImpl(endpoint(baseUrl, apiKey ? "search" : "search/public"), {
          method: "POST",
          headers: { ...headers(apiKey), "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: withTimeout(signal),
        });
      } catch (error) {
        return networkErrorResult(error);
      }
      if (!response.ok) return requestErrorResult(response, apiKey);

      const data = (await response.json().catch(() => undefined)) as { results?: unknown } | undefined;
      if (!data || !Array.isArray(data.results)) return failedResult("Keenable returned an invalid search response.");
      const hits = (data.results as KeenableSearchResult[])
        .filter((r): r is KeenableSearchResult & { url: string } => typeof r?.url === "string" && r.url.length > 0)
        .slice(0, SEARCH_RESULTS)
        .map((r) => ({
          title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : r.url,
          url: r.url,
          snippet: typeof r.snippet === "string" ? clip(r.snippet.replace(/\s+/g, " ").trim(), SNIPPET_CAP) : "",
        }));
      if (hits.length === 0) return textResult(`No results for "${query}".`);
      const lines = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`);
      return textResult(wrapUntrusted(lines.join("\n"), `Keenable search results for ${query}`));
    },
  });
}

function keenableFetchTool({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, lookup }: KeenableToolDeps): RegisteredTool {
  return defineTool({
    name: "keenable_fetch",
    label: "Fetch web page through Keenable",
    description:
      "Fetch a public http(s) URL through Keenable and return the page as markdown (up to 20k characters). Public hosts only: no localhost, private networks or cloud metadata. No logins; use the computer for pages that need one.",
    parameters: Type.Object({ url: Type.String() }),
    meta: { capabilities: ["web.read"], group: "web", describe: (args) => `fetch ${argText(args, "url")}` },
    execute: async ({ url }, _ctx, signal) => {
      // The page is fetched by Keenable, not from this machine, but the agent keeps the same
      // public-hosts-only rule as web_fetch so private names never leave the VM.
      const check = await checkPublicTarget(url, lookup);
      if (!check.ok) return failedResult(`Cannot fetch ${url}: ${check.reason}`);
      const target = new URL(endpoint(baseUrl, apiKey ? "fetch" : "fetch/public"));
      target.searchParams.set("url", check.target.url.toString());
      let response: Response;
      try {
        response = await fetchImpl(target.toString(), { method: "GET", headers: headers(apiKey), signal: withTimeout(signal) });
      } catch (error) {
        return networkErrorResult(error);
      }
      if (!response.ok) return requestErrorResult(response, apiKey);

      const page = (await response.json().catch(() => undefined)) as KeenablePage | undefined;
      if (!page || typeof page.content !== "string") return failedResult("Keenable returned an invalid page.");
      const finalUrl = typeof page.url === "string" && page.url ? page.url : check.target.url.toString();
      const title = typeof page.title === "string" ? page.title.trim() : "";
      const text = clip(page.content.trim(), PAGE_TEXT_CAP) || "(empty page)";
      return textResult(wrapUntrusted(`${title ? `# ${title}\n` : ""}${finalUrl}\n\n${text}`, `web page ${hostOf(finalUrl)} via Keenable`));
    },
  });
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path}`;
}

function headers(apiKey: string | undefined): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": "open-instinct/0.1",
    "X-Keenable-Title": APP_TITLE,
    ...(apiKey ? { "X-API-Key": apiKey } : {}),
  };
}

/** The runner's signal cancels a turn; the timeout still applies when the runner never does. */
function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function networkErrorResult(error: unknown): ToolResultLike {
  const timedOut = error instanceof Error && error.name === "TimeoutError";
  return failedResult(timedOut ? "Keenable did not answer in time." : "Could not reach Keenable.");
}

function requestErrorResult(response: Response, apiKey: string | undefined): ToolResultLike {
  if (response.status === 429) {
    return failedResult(
      apiKey
        ? "Keenable rate limit reached for this API key. Try again in a moment."
        : "Keenable rate limit reached. Try again in a moment; the person running this agent can set KEENABLE_API_KEY for higher limits.",
    );
  }
  if (apiKey && (response.status === 401 || response.status === 403)) {
    return failedResult("Keenable rejected the API key. The person running this agent must check KEENABLE_API_KEY.");
  }
  return failedResult(`Keenable request failed with HTTP ${response.status}.`);
}

function failedResult(message: string): ToolResultLike {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** YYYY-MM-DD naming a real day. Date rolls 2026-02-30 over into March, so the round trip must match. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown host";
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function argText(args: unknown, key: string): string {
  const value = (args as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? clip(value, 120) : "";
}

/**
 * Tools that ship with core: memory, schedules, owner relay, audit, plain web access,
 * and PDF creation. Messaging, contacts, computer and apps live in their own packages.
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { ApprovalStore } from "./approvals.js";
import type { AuditLog } from "./audit.js";
import type { MemoryStore } from "./memory.js";
import { checkPublicTarget, type Lookup } from "./net-guard.js";
import { pdfPageCount, renderMarkdownToPdf } from "./pdf.js";
import { wrapUntrusted } from "./prompt.js";
import type { Outbox } from "./runtime.js";
import type { Scheduler } from "./scheduler.js";
import { SPEND_CAPABILITIES } from "./policy.js";
import { defineTool, textResult, type RegisteredTool, type ToolContext, type ToolResultLike } from "./tools.js";
import type { Approval, AuditKind, InstinctConfig } from "./types.js";

export interface CoreToolDeps {
  memory: MemoryStore;
  scheduler: Scheduler;
  approvals: ApprovalStore;
  audit: AuditLog;
  config: InstinctConfig;
  outbox: Outbox;
  fetchImpl?: typeof fetch;
  /** DNS lookup used to vet web_fetch targets; tests inject a stub. */
  lookup?: Lookup;
  searchApiKey?: string;
  /** Opt-in You.com web search. With apiKey it calls the keyed API; without it, the keyless free tier (100 searches a day per IP). */
  youSearch?: { apiKey?: string };
  /** The owner's workspace directory. create_pdf writes under it; without it the tool refuses. */
  workspaceDir?: string;
  /** Called after approval_settle resolves an approval, so the runtime can wake the conversation that was waiting. */
  onApprovalSettled?: (approval: Approval, approved: boolean) => Promise<void> | void;
  /** An OpenAI-compatible images endpoint (`POST {baseUrl}/images/generations`). Without it image_generate explains what to set. */
  images?: { apiKey: string; baseUrl?: string; model?: string };
}

export const DEFAULT_IMAGE_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_IMAGE_MODEL = "gpt-image-1";
const IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
const IMAGE_TIMEOUT_MS = 120_000;

const WEB_TEXT_CAP = 20_000;
/** Bytes read from a fetched page before giving up on the rest. */
export const WEB_BODY_CAP_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const SEARCH_RESULTS = 8;

export function coreTools(deps: CoreToolDeps): RegisteredTool[] {
  return [
    ...memoryTools(deps),
    ...scheduleTools(deps),
    ...ownerTools(deps),
    auditTool(deps),
    webFetchTool(deps),
    webSearchTool(deps),
    createPdfTool(deps),
    imageGenerateTool(deps),
  ];
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function memoryTools({ memory }: CoreToolDeps): RegisteredTool[] {
  // Memory holds the owner's private notes, so reading it needs the same capability as
  // writing it. The prompt digest already gives the model what it needs for most turns.
  const memoryRead = defineTool({
    name: "memory_read",
    label: "Read memory",
    description: "Read durable memory (MEMORY.md) or today's journal. Use section \"journal\" for the journal, otherwise durable memory is returned.",
    parameters: Type.Object({ section: Type.Optional(Type.String({ description: "\"durable\" (default) or \"journal\"" })) }),
    meta: { capabilities: ["memory.write"], group: "memory" },
    execute: async ({ section }, ctx) => {
      if (section?.toLowerCase() === "journal") return textResult(memory.readJournal(ctx.now()) || "(journal is empty today)");
      return textResult(memory.readDurable() || "(memory is empty)");
    },
  });

  const memoryWrite = defineTool({
    name: "memory_write",
    label: "Write memory",
    description: "Remember something. durable=true appends to MEMORY.md (facts, preferences, people). Otherwise it goes to today's journal.",
    parameters: Type.Object({
      text: Type.String({ description: "What to remember, one or two sentences" }),
      durable: Type.Optional(Type.Boolean({ description: "true for long-term memory, false for the daily journal" })),
    }),
    meta: { capabilities: ["memory.write"], group: "memory", describe: (a) => `remember: ${argText(a, "text")}` },
    execute: async ({ text, durable }, ctx) => {
      if (durable) {
        memory.appendDurable(text.trim());
        return textResult("Saved to durable memory.");
      }
      memory.appendJournal(text.trim(), ctx.now());
      return textResult("Noted in today's journal.");
    },
  });

  const journalAppend = defineTool({
    name: "journal_append",
    label: "Journal",
    description: "Append a line to today's journal: what happened, what was decided, what is pending.",
    parameters: Type.Object({ text: Type.String() }),
    meta: { capabilities: ["memory.write"], group: "memory", describe: (a) => `journal: ${argText(a, "text")}` },
    execute: async ({ text }, ctx) => {
      memory.appendJournal(text.trim(), ctx.now());
      return textResult("Journaled.");
    },
  });

  return [memoryRead, memoryWrite, journalAppend];
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

function scheduleTools({ scheduler, config }: CoreToolDeps): RegisteredTool[] {
  const create = defineTool({
    name: "schedule_create",
    label: "Create schedule",
    description:
      "Schedule a prompt to run later. Give cron (5 fields, in tz) for repeating jobs or at (ISO timestamp) for one-shot. The prompt runs as the owner and the result is texted to them.",
    parameters: Type.Object({
      name: Type.String({ description: "Short name, e.g. \"morning briefing\"" }),
      prompt: Type.String({ description: "What to do when it fires" }),
      cron: Type.Optional(Type.String({ description: "minute hour day-of-month month day-of-week" })),
      tz: Type.Optional(Type.String({ description: "IANA timezone; defaults to the owner's" })),
      at: Type.Optional(Type.String({ description: "ISO timestamp for a one-shot run" })),
    }),
    meta: { capabilities: ["schedule.manage"], group: "schedule", describe: (a) => `schedule ${argText(a, "name")}` },
    execute: async ({ name, prompt, cron, tz, at }) => {
      if (!cron && !at) return { content: [{ type: "text", text: "Give either cron or at." }], isError: true };
      if (at && Number.isNaN(Date.parse(at))) return { content: [{ type: "text", text: `Invalid timestamp: ${at}` }], isError: true };
      const entry = scheduler.create({
        name,
        prompt,
        enabled: true,
        ...(cron ? { cron } : {}),
        tz: tz ?? config.owner.timezone,
        ...(at ? { nextRunAt: new Date(at).toISOString() } : {}),
      });
      return textResult(`Scheduled "${entry.name ?? entry.id}" (id ${entry.id}). Next run: ${entry.nextRunAt ?? "unknown"}.`);
    },
  });

  const list = defineTool({
    name: "schedule_list",
    label: "List schedules",
    description: "List scheduled jobs with ids, cron or next run, and enabled state.",
    parameters: Type.Object({}),
    meta: { capabilities: ["schedule.manage"], group: "schedule" },
    execute: async () => {
      const entries = scheduler.list();
      if (entries.length === 0) return textResult("No schedules.");
      const lines = entries.map(
        (e) => `${e.id}: ${e.name ?? "(unnamed)"} | ${e.cron ? `cron ${e.cron} ${e.tz ?? ""}`.trim() : `once at ${e.nextRunAt ?? "?"}`} | next ${e.nextRunAt ?? "-"} | ${e.enabled ? "on" : "off"}`,
      );
      return textResult(lines.join("\n"));
    },
  });

  const remove = defineTool({
    name: "schedule_delete",
    label: "Delete schedule",
    description: "Delete a scheduled job by id.",
    parameters: Type.Object({ id: Type.String() }),
    meta: { capabilities: ["schedule.manage"], group: "schedule", describe: (a) => `delete schedule ${argText(a, "id")}` },
    execute: async ({ id }) => textResult(scheduler.delete(id) ? `Deleted ${id}.` : `No schedule with id ${id}.`),
  });

  return [create, list, remove];
}

// ---------------------------------------------------------------------------
// Owner relay
// ---------------------------------------------------------------------------

function ownerTools({ approvals, config, outbox, audit, onApprovalSettled }: CoreToolDeps): RegisteredTool[] {
  const ownerPhone = () => config.owner.phones[0];

  const sendOwner = async (text: string, ctx: ToolContext): Promise<boolean> => {
    const phone = ownerPhone();
    if (!phone) return false;
    await outbox.send({ channel: "imessage", to: phone, text }, { principal: ctx.principal, conversationKey: ctx.conversationKey });
    audit.append({ kind: "outbound", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { channel: "imessage", to: phone, chars: text.length, via: "owner_relay" } });
    return true;
  };

  const askOwner = defineTool({
    name: "ask_owner",
    label: "Ask owner",
    description:
      "Ask the owner a yes/no question or for approval. Sends them a text and returns an approval token. Then tell the requester you are checking and end your turn; the answer arrives as a new message.",
    parameters: Type.Object({
      question: Type.String({ description: "The text the owner will read" }),
      summary: Type.String({ description: "One line describing what is being approved" }),
      amountUsd: Type.Optional(Type.Number({ description: "Money involved, if any" })),
    }),
    meta: { capabilities: ["owner.relay"], group: "owner", amountUsd: (a) => argNumber(a, "amountUsd"), describe: (a) => `ask owner: ${argText(a, "summary")}` },
    execute: async ({ question, summary, amountUsd }, ctx) => {
      const approval = approvals.create({
        conversationKey: ctx.conversationKey,
        requestedBy: ctx.principal.id,
        summary,
        capability: "owner.relay",
        ...(amountUsd !== undefined ? { amountUsd } : {}),
      });
      audit.append({ kind: "approval", conversationKey: ctx.conversationKey, principal: ctx.principal.id, detail: { token: approval.token, status: "pending", summary } });
      const who = ctx.principal.kind === "owner" ? "" : ` (from ${ctx.principal.displayName})`;
      // The token stays internal: the owner reads a plain question and answers however they like.
      const sent = await sendOwner(`${question}${who}`, ctx);
      // The question is now the last thing the owner heard from us, so a bare "yes" is about it.
      if (sent) approvals.markPrompted(approval.token);
      return textResult(
        sent
          ? `Asked ${config.owner.name}. Token ${approval.token}, expires ${approval.expiresAt}. Wait for their answer.`
          : `Approval ${approval.token} recorded but the owner has no phone on file; they can answer in chat.`,
      );
    },
  });

  const notifyOwner = defineTool({
    name: "notify_owner",
    label: "Notify owner",
    description: "Send the owner a short text message. Use it to pass along a message from someone else or to flag something they should know.",
    parameters: Type.Object({ text: Type.String() }),
    meta: { capabilities: ["owner.relay"], group: "owner", describe: (a) => `notify owner: ${argText(a, "text")}` },
    execute: async ({ text }, ctx) => {
      const prefix = ctx.principal.kind === "owner" ? "" : `${ctx.principal.displayName} via ${config.agent.name}: `;
      const sent = await sendOwner(`${prefix}${text}`, ctx);
      // Something other than an approval question is now the last message; a bare "yes" would be ambiguous.
      if (sent) approvals.clearPrompted();
      return textResult(sent ? `Sent to ${config.owner.name}.` : "The owner has no phone on file; nothing was sent.");
    },
  });

  const settleApproval = defineTool({
    name: "approval_settle",
    label: "Settle approval",
    description:
      "Record the owner's answer to a pending approval when they answer in their own words (\"tell him yes\", \"no, skip that\", \"go ahead with the intro\") rather than a plain yes or no. Owner only. Pass the token when more than one approval is pending.",
    parameters: Type.Object({
      decision: Type.Union([Type.Literal("yes"), Type.Literal("no")]),
      token: Type.Optional(Type.String({ description: "The 4-character token from the pending approvals list" })),
    }),
    meta: { capabilities: ["converse"], group: "owner", describe: (a) => `settle approval ${argText(a, "token") || "(only pending)"}: ${argText(a, "decision")}` },
    execute: async ({ decision, token }, ctx) => {
      if (ctx.principal.kind !== "owner") return { content: [{ type: "text", text: "Only the owner can settle an approval." }], isError: true };
      // The owner's words have to be what started this run. An email, another agent's reply, a
      // scheduled job or a resumed task runs as the owner too, but its text is not theirs.
      if (!ctx.ownerTurn) {
        return {
          content: [{ type: "text", text: "Only the owner's own message can settle an approval, and this turn did not start with one. Ask the owner and let them answer." }],
          isError: true,
        };
      }
      const pending = approvals.pending();
      if (pending.length === 0) return textResult("Nothing is pending.");
      const wanted = token?.trim().toUpperCase();
      const target = wanted ? pending.find((a) => a.token === wanted) : pending.length === 1 ? pending[0] : undefined;
      if (!target) return textResult(`Which one? Pending: ${pending.map((a) => `${a.token}: ${a.summary}`).join("; ")}. Call again with the token.`);
      // Money moves only on the owner's own plain yes, never on the model's reading of their words.
      if (SPEND_CAPABILITIES.has(target.capability) || target.amountUsd !== undefined) {
        return textResult(`${target.summary} involves money, so only the owner's own yes settles it. Ask whether they want to go ahead; a plain yes or no from them is handled automatically.`);
      }
      // A phone call is outward-facing and billed: the same rule, so an injected "tell it yes" never dials.
      if (target.capability === "phone.call") {
        return textResult(`${target.summary} is a phone call, so only the owner's own yes settles it. Ask whether they want to go ahead; a plain yes or no from them is handled automatically.`);
      }
      const approved = decision === "yes";
      const resolved = approvals.resolve(target.token, approved);
      if (!resolved) return textResult("That approval is no longer pending.");
      audit.append({ kind: "approval", conversationKey: resolved.conversationKey, principal: ctx.principal.id, detail: { token: resolved.token, status: resolved.status, summary: resolved.summary, via: "approval_settle" } });
      await onApprovalSettled?.(resolved, approved);
      return textResult(`${approved ? "Approved" : "Denied"}: ${resolved.summary}. The conversation that was waiting has been resumed; confirm to the owner in one line.`);
    },
  });

  return [askOwner, notifyOwner, settleApproval];
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function auditTool({ audit }: CoreToolDeps): RegisteredTool {
  return defineTool({
    name: "audit_read",
    label: "Read audit log",
    description: "Read recent audit entries: messages, tool calls, policy decisions, approvals, spend. Owner only.",
    parameters: Type.Object({
      since: Type.Optional(Type.String({ description: "ISO timestamp; default is the last 24 hours" })),
      limit: Type.Optional(Type.Number({ description: "Max entries, default 50" })),
      kinds: Type.Optional(Type.Array(Type.String({ description: "inbound, outbound, tool_call, policy, approval, spend, schedule, error" }))),
    }),
    meta: { capabilities: ["trust.manage"], group: "owner" },
    execute: async ({ since, limit, kinds }, ctx) => {
      const from = since ?? new Date(ctx.now().getTime() - 24 * 3600 * 1000).toISOString();
      const entries = audit.read({ since: from, limit: limit ?? 50, ...(kinds?.length ? { kinds: kinds as AuditKind[] } : {}) });
      if (entries.length === 0) return textResult("Nothing in the audit log for that window.");
      const lines = entries.map((e) => `${e.at} ${e.kind}${e.principal ? ` [${e.principal}]` : ""} ${clip(JSON.stringify(e.detail), 240)}`);
      return textResult(lines.join("\n"));
    },
  });
}

// ---------------------------------------------------------------------------
// Web
// ---------------------------------------------------------------------------

function webFetchTool({ fetchImpl, lookup }: CoreToolDeps): RegisteredTool {
  const doFetch = fetchImpl ?? fetch;
  return defineTool({
    name: "web_fetch",
    label: "Fetch web page",
    description: "Fetch a public http(s) URL and return its text (HTML stripped, up to 20k characters). Public hosts only: no localhost, private networks or cloud metadata. No logins; use the computer for pages that need one.",
    parameters: Type.Object({ url: Type.String() }),
    meta: { capabilities: ["web.read"], group: "web", describe: (a) => `fetch ${argText(a, "url")}` },
    execute: async ({ url }, _ctx, signal) => {
      const fetched = await fetchPublic(doFetch, url, { signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(lookup ? { lookup } : {}) });
      if (!fetched.ok) return { content: [{ type: "text", text: `Cannot fetch ${url}: ${fetched.reason}` }], isError: true };
      const { res, target, hops } = fetched;
      const type = res.headers.get("content-type") ?? "";
      const raw = await readBody(res, WEB_BODY_CAP_BYTES);
      const text = type.includes("html") ? htmlToText(raw) : raw;
      const body = clip(text.trim(), WEB_TEXT_CAP);
      const final = hops.length > 0 ? ` (final: ${hops[hops.length - 1]})` : "";
      const head = `HTTP ${res.status} ${target.host}${final}\n`;
      return textResult(head + wrapUntrusted(body || "(empty page)", `web page ${new URL(hops[hops.length - 1] ?? target.toString()).host}`));
    },
  });
}

interface FetchPublicOptions {
  signal?: AbortSignal;
  lookup?: Lookup;
  headers?: Record<string, string>;
}

type FetchPublicResult = { ok: true; res: Response; target: URL; hops: string[] } | { ok: false; reason: string };

/**
 * Fetch a URL that must be on the public internet, following at most MAX_REDIRECTS
 * redirects and vetting every hop with the same check, so a public page cannot bounce the
 * agent to 127.0.0.1 or the metadata service.
 */
export async function fetchPublic(doFetch: typeof fetch, url: string, opts: FetchPublicOptions = {}): Promise<FetchPublicResult> {
  const headers = opts.headers ?? {
    "user-agent": "open-instinct/0.1 (+https://github.com/mariagorskikh/open-instinct)",
    accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
  };
  const hops: string[] = [];
  let current = url;
  let first: URL | undefined;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const check = await checkPublicTarget(current, opts.lookup);
    if (!check.ok) return { ok: false, reason: hops.length ? `redirect to ${current} refused: ${check.reason}` : check.reason };
    const target = check.target.url;
    first ??= target;
    const res = await doFetch(target.toString(), { ...(opts.signal ? { signal: opts.signal } : {}), headers, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        return { ok: false, reason: `bad redirect location: ${location}` };
      }
      if (i === MAX_REDIRECTS) return { ok: false, reason: `too many redirects (more than ${MAX_REDIRECTS})` };
      hops.push(next.toString());
      current = next.toString();
      continue;
    }
    return { ok: true, res, target: first, hops };
  }
  return { ok: false, reason: `too many redirects (more than ${MAX_REDIRECTS})` };
}

/** Read at most `cap` bytes of a response body as UTF-8 text. */
async function readBody(res: Response, cap: number): Promise<string> {
  const body = res.body;
  if (!body) return await res.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const room = cap - total;
      const slice = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(slice);
      total += slice.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

function webSearchTool({ fetchImpl, searchApiKey, youSearch }: CoreToolDeps): RegisteredTool {
  const doFetch = fetchImpl ?? fetch;
  return defineTool({
    name: "web_search",
    label: "Web search",
    description: "Search the web and return the top results with titles, links and snippets.",
    parameters: Type.Object({ query: Type.String() }),
    meta: { capabilities: ["web.read"], group: "web", describe: (a) => `search ${argText(a, "query")}` },
    execute: async ({ query }, _ctx, signal) => {
      const hits = youSearch
        ? await youComSearch(doFetch, youSearch.apiKey, query, signal)
        : searchApiKey
          ? await braveSearch(doFetch, searchApiKey, query, signal)
          : await duckDuckGoSearch(doFetch, query, signal);
      if (hits.length === 0) return textResult(`No results for "${query}".`);
      const lines = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`);
      return textResult(wrapUntrusted(lines.join("\n"), `web search results for ${query}`));
    },
  });
}

async function braveSearch(doFetch: typeof fetch, key: string, query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(SEARCH_RESULTS));
  const res = await doFetch(url.toString(), {
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json", "x-subscription-token": key },
  });
  if (!res.ok) throw new Error(`Brave Search failed: HTTP ${res.status}`);
  const data = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (data.web?.results ?? [])
    .filter((r) => r.url)
    .slice(0, SEARCH_RESULTS)
    .map((r) => ({ title: r.title ?? r.url!, url: r.url!, snippet: htmlToText(r.description ?? "") }));
}

export const YOU_KEYED_URL = "https://ydc-index.io/v1/search";
export const YOU_KEYLESS_URL = "https://api.you.com/v1/agents/search";
const YOU_USER_AGENT = "youdotcom-integration/mariagorskikh-open-instinct";
/** Longest Retry-After we wait out inside one tool call; anything longer fails with the wait in the message. */
const YOU_MAX_RETRY_AFTER_S = 10;

/** 429 error that keeps the server's Retry-After wait, when it sent one. */
function youRateLimitError(res: Response): Error {
  const wait = Number(res.headers.get("retry-after"));
  return new Error(`You.com search is rate limited (HTTP 429)${Number.isFinite(wait) && wait > 0 ? `; retry after ${wait}s` : ""}`);
}

/** You.com search: POST with X-API-Key when keyed, GET on the keyless endpoint otherwise. Retries a 429 once if Retry-After is short. */
async function youComSearch(doFetch: typeof fetch, key: string | undefined, query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const send = (): Promise<Response> => {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": YOU_USER_AGENT };
    const init: RequestInit = { signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS), headers };
    if (key) {
      headers["x-api-key"] = key;
      headers["content-type"] = "application/json";
      return doFetch(YOU_KEYED_URL, { ...init, method: "POST", body: JSON.stringify({ query, count: SEARCH_RESULTS }) });
    }
    const url = new URL(YOU_KEYLESS_URL);
    url.searchParams.set("query", query);
    url.searchParams.set("count", String(SEARCH_RESULTS));
    return doFetch(url.toString(), init);
  };
  let res = await send();
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after"));
    if (!Number.isFinite(wait) || wait < 0 || wait > YOU_MAX_RETRY_AFTER_S) throw youRateLimitError(res);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await send();
  }
  if (res.status === 401 || res.status === 403) throw new Error(`You.com search rejected the API key (HTTP ${res.status}); check YDC_API_KEY`);
  if (res.status === 402) {
    throw new Error(
      key
        ? "You.com search quota is used up for this API key (HTTP 402); check the plan or credits for YDC_API_KEY"
        : "You.com search quota is used up (HTTP 402). The keyless tier allows 100 searches a day per IP; set YDC_API_KEY for more",
    );
  }
  if (res.status === 429) throw youRateLimitError(res);
  if (!res.ok) throw new Error(`You.com search failed: HTTP ${res.status}`);
  const data = (await res.json()) as { results?: { web?: Array<{ title?: string; url?: string; description?: string; snippets?: string[] }> } };
  return (data.results?.web ?? [])
    .filter((r) => r.url)
    .slice(0, SEARCH_RESULTS)
    .map((r) => ({ title: r.title ?? r.url!, url: r.url!, snippet: htmlToText(r.description || r.snippets?.[0] || "") }));
}

async function duckDuckGoSearch(doFetch: typeof fetch, query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const res = await doFetch(url.toString(), {
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "Mozilla/5.0 (compatible; open-instinct/0.1)", accept: "text/html" },
  });
  if (!res.ok) throw new Error(`DuckDuckGo search failed: HTTP ${res.status}`);
  return parseDuckDuckGoHtml(await res.text()).slice(0, SEARCH_RESULTS);
}

/** DuckDuckGo's HTML endpoint: one `result__a` link and one `result__snippet` per hit. */
export function parseDuckDuckGoHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  const snippets: string[] = [];
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) snippets.push(htmlToText(m[1] ?? m[2] ?? ""));
  let i = 0;
  for (let m = linkRe.exec(html); m; m = linkRe.exec(html), i++) {
    const href = decodeDuckDuckGoHref(decodeEntities(m[1] ?? ""));
    const title = htmlToText(m[2] ?? "");
    if (!href || !title) continue;
    hits.push({ title, url: href, snippet: snippets[i] ?? "" });
  }
  return hits;
}

/** DDG wraps targets as //duckduckgo.com/l/?uddg=<encoded url>; unwrap to the real link. */
function decodeDuckDuckGoHref(href: string): string {
  const absolute = href.startsWith("//") ? `https:${href}` : href;
  try {
    const u = new URL(absolute, "https://duckduckgo.com");
    const target = u.searchParams.get("uddg");
    if (target) return decodeURIComponent(target);
    return u.toString();
  } catch {
    return absolute;
  }
}

/** A small HTML to text pass: drop scripts and styles, turn block tags into line breaks, decode entities. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer|\/blockquote|\/pre)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "-", ndash: "-", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Where a workspace-relative (or absolute, inside the workspace) path lands as a
 * canonical absolute path, or undefined when it escapes the workspace. A symlinked
 * workspace is accepted under either its given or its real path.
 */
export function resolveWorkspacePath(workspaceDir: string, requested: string): string | undefined {
  if (!requested || requested.includes("\0")) return undefined;
  const rawRoot = path.resolve(workspaceDir);
  let realRoot = rawRoot;
  try {
    realRoot = fs.realpathSync(rawRoot);
  } catch {
    // The workspace may not exist yet; the given root still bounds the check.
  }
  const inside = (root: string, target: string) => target !== root && target.startsWith(root + path.sep);
  const target = path.resolve(rawRoot, requested);
  if (inside(rawRoot, target)) return path.join(realRoot, path.relative(rawRoot, target));
  if (inside(realRoot, target)) return target;
  return undefined;
}

function createPdfTool({ workspaceDir, config }: CoreToolDeps): RegisteredTool {
  return defineTool({
    name: "create_pdf",
    label: "Create PDF",
    description:
      "Write a PDF into the workspace from markdown (headings, paragraphs, lists, bold, code blocks, pipe tables). Returns the absolute path, size and page count. Send it afterwards with send_file.",
    parameters: Type.Object({
      path: Type.String({ description: "Where to write, relative to the workspace, ending in .pdf, e.g. research/2026-10-03-brief.pdf" }),
      markdown: Type.String({ description: "The document body in markdown" }),
      title: Type.Optional(Type.String({ description: "Title printed at the top and stored in the PDF metadata" })),
    }),
    meta: { capabilities: ["files.write"], group: "files", describe: (a) => `create_pdf ${argText(a, "path")}` },
    execute: async ({ path: requested, markdown, title }) => {
      if (!workspaceDir) return fail("No workspace is configured, so PDFs cannot be written.");
      if (!/\.pdf$/i.test(requested.trim())) return fail(`The path must end in .pdf: ${requested}`);
      const target = resolveWorkspacePath(workspaceDir, requested.trim());
      if (!target) return fail(`Refused: "${requested}" is outside the workspace.`);
      const pdf = await renderMarkdownToPdf(markdown, {
        ...(title ? { title } : {}),
        author: config.agent.name,
        // `![alt](images/ship.png)` embeds a file from the workspace; anything outside it is refused.
        resolveImage: (src) => {
          const file = resolveWorkspacePath(workspaceDir, src.trim());
          return file && fs.existsSync(file) ? file : undefined;
        },
      });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, pdf);
      const pages = pdfPageCount(pdf);
      return { content: [{ type: "text", text: `Wrote ${target} (${formatBytes(pdf.length)}, ${pages} page${pages === 1 ? "" : "s"}).` }], details: { path: target, bytes: pdf.length, pages } };
    },
  });
}

function imageGenerateTool({ workspaceDir, images, fetchImpl }: CoreToolDeps): RegisteredTool {
  const doFetch = fetchImpl ?? fetch;
  return defineTool({
    name: "image_generate",
    label: "Generate image",
    description:
      "Generate an image from a text prompt and save it as a PNG in the workspace. Returns the path. Put it in a PDF with create_pdf using ![caption](path), or send it with send_file. Describe the subject, style, mood and composition in the prompt.",
    parameters: Type.Object({
      prompt: Type.String({ description: "What to draw, in one or two sentences" }),
      path: Type.String({ description: "Where to save, relative to the workspace, ending in .png, e.g. art/ship-01.png" }),
      size: Type.Optional(Type.Union(IMAGE_SIZES.map((s) => Type.Literal(s)), { description: "1024x1024 (default), 1024x1536 portrait or 1536x1024 landscape" })),
    }),
    meta: { capabilities: ["files.write"], group: "files", describe: (a) => `generate image ${argText(a, "path")}: ${argText(a, "prompt")}` },
    execute: async ({ prompt, path: requested, size }, _ctx, signal) => {
      if (!workspaceDir) return fail("No workspace is configured, so images cannot be saved.");
      if (!images) return fail("Image generation is not set up on this agent: the deployer sets IMAGE_API_KEY (or OPENAI_API_KEY) and optionally IMAGE_BASE_URL and IMAGE_MODEL. Say that in one line and offer a text-only version.");
      if (!/\.png$/i.test(requested.trim())) return fail(`The path must end in .png: ${requested}`);
      const target = resolveWorkspacePath(workspaceDir, requested.trim());
      if (!target) return fail(`Refused: "${requested}" is outside the workspace.`);
      const base = (images.baseUrl ?? DEFAULT_IMAGE_BASE_URL).replace(/\/+$/, "");
      let res: Response;
      try {
        res = await doFetch(`${base}/images/generations`, {
          method: "POST",
          headers: { Authorization: `Bearer ${images.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ model: images.model ?? DEFAULT_IMAGE_MODEL, prompt, size: size ?? "1024x1024", n: 1 }),
          signal: signal ?? AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        });
      } catch (err) {
        return fail(`Image generation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const text = await res.text();
      if (!res.ok) return fail(`Image generation failed (HTTP ${res.status}): ${clip(text.replace(/\s+/g, " "), 200)}`);
      let payload: { data?: Array<{ b64_json?: string; url?: string }> };
      try {
        payload = JSON.parse(text) as typeof payload;
      } catch {
        return fail("Image generation failed: the endpoint did not return JSON.");
      }
      const first = payload.data?.[0];
      let bytes: Buffer | undefined;
      if (first?.b64_json) bytes = Buffer.from(first.b64_json, "base64");
      else if (first?.url) {
        const img = await doFetch(first.url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
        if (!img.ok) return fail(`Image generation failed: could not download the result (HTTP ${img.status}).`);
        bytes = Buffer.from(await img.arrayBuffer());
      }
      if (!bytes || bytes.length === 0) return fail("Image generation failed: the endpoint returned no image.");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      return { content: [{ type: "text", text: `Saved ${target} (${formatBytes(bytes.length)}). Embed it with ![caption](${requested.trim()}) in create_pdf, or send it with send_file.` }], details: { path: target, bytes: bytes.length } };
    },
  });
}

function fail(text: string): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function argText(args: unknown, key: string): string {
  const v = (args as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" ? clip(v, 120) : "";
}

function argNumber(args: unknown, key: string): number | undefined {
  const v = (args as Record<string, unknown> | undefined)?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

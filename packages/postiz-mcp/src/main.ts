import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PostizClient } from "./postiz.js";
import { TOOLS, callTool } from "./tools.js";

export interface PostizMcpOptions {
  /** POSTIZ_API_URL — the Postiz public API base, e.g. https://scheduler.foundersynergy.network/api */
  postizApiUrl: string;
  fetchImpl?: typeof fetch;
  log?: (line: Record<string, unknown>) => void;
}

const MAX_BODY_BYTES = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Composio calls the toolkit with `Authorization: Bearer <generic_api_key>`. The key is the person's own Postiz key. */
export function extractPostizKey(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  // "Bearer " or a bare "Bearer" with no token must be null, not the word itself.
  const withoutScheme = raw.replace(/^Bearer\s*/i, "").trim();
  return withoutScheme || null;
}

/**
 * Stateless MCP endpoint: a fresh Server + transport per POST, so the BYOK
 * key that arrived on that request is the only key the tools can use.
 * GET /mcp gets 405 (no server-initiated SSE in stateless mode).
 */
export async function handleMcpPost(req: IncomingMessage, res: ServerResponse, opts: PostizMcpOptions, bodyText: string): Promise<void> {
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const key = extractPostizKey(req.headers.authorization);
  if (!key) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "missing Authorization: Bearer <postiz-api-key>" }, id: null }));
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null }));
    return;
  }

  const client = new PostizClient({ baseUrl: opts.postizApiUrl, apiKey: key, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const server = new McpServer(
    { name: "postiz-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = String(request.params.name);
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await callTool(client, name, args);
    log({ event: "postiz_mcp.tool", tool: name, isError: result.isError === true, ms: Date.now() - started });
    return result;
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function createPostizMcpServer(opts: PostizMcpOptions): Server {
  const log = opts.log ?? (() => {});
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        // Stateless mode: no server-initiated streams, no sessions to delete.
        res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
        res.end(JSON.stringify({ error: "method not allowed; this MCP server is stateless, use POST" }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end();
        return;
      }
      const bodyText = await readBody(req);
      await handleMcpPost(req, res, opts, bodyText);
    })().catch((err: unknown) => {
      log({ event: "postiz_mcp.error", error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }));
      }
    });
  });
  return server;
}

export interface PostizMcpEnv {
  port: number;
  postizApiUrl: string;
}

export function readEnv(env: NodeJS.ProcessEnv): PostizMcpEnv {
  const port = Number(env["PORT"] ?? "3000");
  const postizApiUrl = env["POSTIZ_API_URL"] ?? "";
  if (!postizApiUrl) throw new Error("POSTIZ_API_URL is required (Postiz public API base, e.g. https://scheduler.foundersynergy.network/api)");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid PORT: ${env["PORT"]}`);
  return { port, postizApiUrl };
}

export function startPostizMcp(env: PostizMcpEnv, fetchImpl?: typeof fetch): Server {
  const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));
  const server = createPostizMcpServer({
    postizApiUrl: env.postizApiUrl,
    log,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  server.listen(env.port, () => {
    log({ event: "postiz_mcp.listening", port: env.port, postizApiUrl: env.postizApiUrl });
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(0), 10_000);
    deadline.unref();
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return server;
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    startPostizMcp(readEnv(process.env));
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

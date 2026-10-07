/**
 * `instinct dev`: run the agent server in this process. No Docker, no
 * Maritime. Secrets from init are loaded into env first. With --tunnel the
 * process also opens an Inkbox tunnel and subscribes the webhook, mirroring
 * the server's own main.ts so iMessage reaches a laptop.
 */
import { loadConfig } from "@open-instinct/core";
import { parse, str, flag, type OptionSpec } from "../args.js";
import type { CliContext } from "../context.js";
import { readSecrets, applySecretsToEnv } from "../secrets.js";

/**
 * The slice of @open-instinct/server the CLI calls. Only `boot` and
 * `createHttpServer` are required; the webhook helpers are used when present.
 */
export interface ServerModule {
  boot(env: NodeJS.ProcessEnv, opts?: { logger?: (m: string) => void }): Promise<BootLike>;
  createHttpServer(app: BootLike, opts?: HttpOptsLike): Listenable;
  closeInkboxInbox?(app: BootLike): Promise<void>;
  listenTunnelServer?(app: BootLike, opts?: HttpOptsLike): Promise<Listenable & { address(): { port: number } | string | null }>;
  ensureWebhookSubscription?(opts: {
    adminApiKey: string;
    baseUrl?: string;
    handle: string;
    identityId?: string;
    url: string;
    state: unknown;
    knownSigningKey?: string;
    logger?: (m: string) => void;
  }): Promise<{ subscriptionId: string; created: boolean; signingKey?: string }>;
  readWebhookSecrets?(state: unknown): { signingKey?: string };
}

export interface BootLike {
  state?: unknown;
  close?(): Promise<void>;
  [k: string]: unknown;
}

export interface HttpOptsLike {
  env?: NodeJS.ProcessEnv;
  logger?: (m: string) => void;
  signingKeyProvider?: () => string | undefined;
}

export interface Listenable {
  listen(port: number, host: string, cb?: () => void): unknown;
  once?(event: "error", cb: (err: Error) => void): unknown;
  close?(cb?: () => void): unknown;
}

export interface TunnelHandle {
  publicUrl: string;
  close(): Promise<void>;
}

export type TunnelConnector = (opts: { apiKey: string; handle: string; baseUrl?: string; forwardTo: string; log: (m: string) => void }) => Promise<TunnelHandle>;

async function defaultImportServer(): Promise<ServerModule> {
  const mod = (await import("@open-instinct/server")) as unknown as Partial<ServerModule>;
  if (typeof mod.boot !== "function" || typeof mod.createHttpServer !== "function") {
    throw new Error("@open-instinct/server does not export boot and createHttpServer");
  }
  return mod as ServerModule;
}

const defaultConnectTunnel: TunnelConnector = async ({ apiKey, handle, baseUrl, forwardTo, log }) => {
  const { Inkbox } = await import("@inkbox/sdk");
  const { connect } = await import("@inkbox/sdk/tunnels/connect");
  const listener = await connect(new Inkbox({ apiKey, ...(baseUrl ? { baseUrl } : {}) }), {
    name: handle,
    forwardTo,
    installSignalHandlers: false,
    onStatus: (status: unknown) => log(`tunnel ${String(status)}`),
  });
  // connect() only registers the tunnel; serveForever() opens the data plane. Without it
  // the public URL exists but every request times out at the edge (504).
  void listener.serveForever().catch((err: unknown) => log(`tunnel stopped: ${(err as Error).message}`));
  return { publicUrl: listener.publicUrl, close: () => listener.close() };
};

export const devOptions: OptionSpec = {
  port: { type: "string" },
  tunnel: { type: "boolean" },
  host: { type: "string" },
  quiet: { type: "boolean" },
};

export async function runDev(ctx: CliContext, argv: string[]): Promise<number> {
  const { values } = parse("dev", argv, devOptions);
  const port = Number(str(values, "port") ?? ctx.env.PORT ?? "8080");
  const host = str(values, "host") ?? "127.0.0.1";
  const { c } = ctx;
  const log = flag(values, "quiet") ? () => {} : (m: string): void => ctx.print(c.dim(`[instinct] ${m}`));

  // The server reads env; we hand it the same object after filling in what init saved.
  const env: NodeJS.ProcessEnv = ctx.env;
  env.INSTINCT_DATA_DIR = ctx.dataDir;
  env.PORT = String(port);
  if (flag(values, "tunnel")) env.INSTINCT_TUNNEL = "1";
  const applied = applySecretsToEnv(env, readSecrets(ctx.dataDir));
  if (applied.length > 0) log(`loaded ${applied.join(", ")} from secrets/inkbox.json`);
  warnIfAppsOff(ctx);

  const server = await (ctx.io.importServer ?? defaultImportServer)();
  const app = await server.boot(env, { logger: log });
  const httpServer = server.createHttpServer(app, {
    env,
    logger: log,
    signingKeyProvider: () => env.INKBOX_SIGNING_KEY ?? server.readWebhookSecrets?.(app.state)?.signingKey,
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once?.("error", reject);
    httpServer.listen(port, host, () => resolve());
  });

  ctx.print(`${c.green("Open Instinct is running")} on http://127.0.0.1:${port}  (data: ${ctx.dataDir})`);
  ctx.print(`  chat:   instinct chat "hello" --url http://127.0.0.1:${port}`);
  ctx.print(`  status: instinct status --url http://127.0.0.1:${port}`);

  let tunnel: TunnelHandle | undefined;
  let tunnelServer: Listenable | undefined;
  if (env.INSTINCT_TUNNEL === "1") {
    tunnel = await (async () => {
      if (!server.listenTunnelServer) throw new Error("The server must support a webhook-only tunnel listener");
      const listener = await server.listenTunnelServer(app, {
        env,
        logger: log,
        signingKeyProvider: () => env.INKBOX_SIGNING_KEY ?? server.readWebhookSecrets?.(app.state)?.signingKey,
      });
      tunnelServer = listener;
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("Webhook listener has no TCP port");
      return startTunnel(ctx, server, app, address.port, log);
    })().catch(async (err: Error) => {
      await new Promise<void>((resolve) => tunnelServer?.close ? tunnelServer.close(resolve) : resolve());
      tunnelServer = undefined;
      ctx.warn(`tunnel not started: ${err.message}`);
      return undefined;
    });
  } else {
    ctx.print(c.dim("  no tunnel: iMessage webhooks need `--tunnel` or the gateway"));
  }

  installShutdown(ctx, log, async () => {
    await tunnel?.close();
    await new Promise<void>((resolve) => tunnelServer?.close ? tunnelServer.close(resolve) : resolve());
    await new Promise<void>((resolve) => (httpServer.close ? httpServer.close(() => resolve()) : resolve()));
    await server.closeInkboxInbox?.(app);
    await app.close?.();
  });
  return 0;
}

/**
 * config.json wins over env after the first boot, so a COMPOSIO_API_KEY exported
 * later does nothing until apps are switched on. Say so instead of booting silently.
 */
export function appsWarning(env: NodeJS.ProcessEnv, appsEnabled: boolean): string | undefined {
  if (!env.COMPOSIO_API_KEY || appsEnabled) return undefined;
  return "COMPOSIO_API_KEY is set but apps are off in config.json (apps.enabled=false), so no Gmail or Calendar tools will load. Run `instinct init --name <you> --apps` (add --toolkits gmail,googlecalendar to choose apps) and start again.";
}

function warnIfAppsOff(ctx: CliContext): void {
  try {
    const config = loadConfig(ctx.state(), ctx.env);
    const warning = appsWarning(ctx.env, config.apps.enabled);
    if (warning) ctx.warn(warning);
  } catch {
    // The server reports config problems itself when it boots.
  }
}

async function startTunnel(ctx: CliContext, server: ServerModule, app: BootLike, port: number, log: (m: string) => void): Promise<TunnelHandle> {
  const { env } = ctx;
  const apiKey = env.INKBOX_API_KEY;
  const handle = env.INKBOX_AGENT_HANDLE;
  if (!apiKey || !handle) throw new Error("INKBOX_API_KEY and INKBOX_AGENT_HANDLE are required (run `instinct init` with INKBOX_ADMIN_API_KEY)");
  const connectTunnel = ctx.io.connectTunnel ?? defaultConnectTunnel;
  const tunnel = await connectTunnel({ apiKey, handle, baseUrl: env.INKBOX_BASE_URL, forwardTo: `http://127.0.0.1:${port}`, log });
  const webhookUrl = `${tunnel.publicUrl.replace(/\/+$/, "")}/webhooks/inkbox`;
  ctx.print(`  tunnel: ${tunnel.publicUrl}`);

  if (env.INKBOX_ADMIN_API_KEY && server.ensureWebhookSubscription) {
    try {
      const result = await server.ensureWebhookSubscription({
        adminApiKey: env.INKBOX_ADMIN_API_KEY,
        baseUrl: env.INKBOX_BASE_URL,
        handle,
        identityId: env.INKBOX_IDENTITY_ID,
        url: webhookUrl,
        state: app.state,
        knownSigningKey: env.INKBOX_SIGNING_KEY,
        logger: log,
      });
      ctx.print(`  webhook: subscription ${result.subscriptionId}${result.created ? " (new)" : ""}`);
    } catch (err) {
      ctx.warn(`webhook subscription failed: ${(err as Error).message}`);
    }
  } else {
    ctx.print(ctx.c.dim(`  webhook: subscribe Inkbox events to ${webhookUrl} (set INKBOX_ADMIN_API_KEY to do this automatically)`));
  }
  return tunnel;
}

function installShutdown(ctx: CliContext, log: (m: string) => void, close: () => Promise<void>): void {
  if (ctx.io.installSignalHandlers === false) return;
  let done = false;
  const shutdown = (signal: string): void => {
    if (done) return;
    done = true;
    log(`${signal}: shutting down`);
    const timer = setTimeout(() => process.exit(0), 10_000);
    timer.unref();
    close().finally(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

/**
 * Entrypoint. boot -> listen -> (optional) Inkbox tunnel + webhook subscription.
 * Reads process.env here and nowhere deeper.
 *
 * Listeners. The owner's surface (/chat, /status, /schedules) binds loopback by
 * default. It binds 0.0.0.0 only when the environment says this is a container
 * (PORT injected by Maritime or set by docker-compose, or MARITIME_* present) or
 * when INSTINCT_BIND asks for it. The Inkbox tunnel never points at that
 * listener: it forwards to a second, loopback-only server that serves /health
 * and /webhooks/inkbox and nothing else.
 */
import type http from "node:http";
import { Inkbox } from "@inkbox/sdk";
import { bindHostFor } from "./bind.js";
import { boot } from "./boot.js";
import { closeInkboxInbox, createHttpServer, listenTunnelServer } from "./http.js";
import { ensureWebhookSubscription, readWebhookSecrets } from "./webhook-setup.js";

const env = process.env;
const log = (m: string): void => console.log(`[instinct] ${m}`);

async function main(): Promise<void> {
  const port = Number(env.PORT ?? 8080);
  const host = bindHostFor(env);
  const app = await boot(env, { logger: log });

  const httpOpts = {
    env,
    logger: log,
    signingKeyProvider: () => env.INKBOX_SIGNING_KEY ?? readWebhookSecrets(app.state).signingKey,
  };
  const server = createHttpServer(app, httpOpts);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  log(`listening on ${host}:${port}`);
  if (host !== "127.0.0.1" && !env.INSTINCT_CHAT_TOKEN) {
    log("warning: /chat is reachable beyond loopback with no INSTINCT_CHAT_TOKEN; rely on this only behind Maritime or a private network");
  }

  let tunnelServer: http.Server | undefined;
  let closeTunnel: (() => Promise<void>) | undefined;
  if (env.INSTINCT_TUNNEL === "1" && env.INKBOX_API_KEY) {
    tunnelServer = await listenTunnelServer(app, httpOpts);
    const tunnelPort = (tunnelServer.address() as { port: number }).port;
    log(`tunnel listener on 127.0.0.1:${tunnelPort} (webhooks only)`);
    closeTunnel = await startTunnel(tunnelPort, app.state).catch((err: Error) => {
      log(`tunnel not started: ${err.message}`);
      return undefined;
    });
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal}: shutting down`);
    const timer = setTimeout(() => process.exit(0), 10_000);
    timer.unref();
    Promise.resolve()
      .then(() => closeTunnel?.())
      .then(() => new Promise<void>((resolve) => (tunnelServer ? tunnelServer.close(() => resolve()) : resolve())))
      .then(() => new Promise<void>((resolve) => server.close(() => resolve())))
      .then(() => closeInkboxInbox(app))
      .then(() => app.close())
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function startTunnel(port: number, state: Awaited<ReturnType<typeof boot>>["state"]): Promise<() => Promise<void>> {
  const handle = env.INKBOX_AGENT_HANDLE ?? "";
  if (!handle) throw new Error("INKBOX_AGENT_HANDLE is required for the tunnel");
  const { connect } = await import("@inkbox/sdk/tunnels/connect");
  const inkbox = new Inkbox({ apiKey: env.INKBOX_API_KEY, ...(env.INKBOX_BASE_URL ? { baseUrl: env.INKBOX_BASE_URL } : {}) });
  const listener = await connect(inkbox, {
    name: handle,
    forwardTo: `http://127.0.0.1:${port}`,
    installSignalHandlers: false,
    onStatus: (status) => log(`tunnel ${status}`),
  });
  // connect() only registers the tunnel; serveForever() opens the data plane.
  void listener.serveForever().catch((err: unknown) => log(`tunnel stopped: ${(err as Error).message}`));
  log(`tunnel up: ${listener.publicUrl} (serves /health and /webhooks/inkbox only)`);

  if (env.INKBOX_ADMIN_API_KEY) {
    try {
      const result = await ensureWebhookSubscription({
        adminApiKey: env.INKBOX_ADMIN_API_KEY,
        baseUrl: env.INKBOX_BASE_URL,
        handle,
        identityId: env.INKBOX_IDENTITY_ID,
        url: `${listener.publicUrl}/webhooks/inkbox`,
        state,
        knownSigningKey: env.INKBOX_SIGNING_KEY,
        logger: log,
      });
      log(`webhooks: subscription ${result.subscriptionId}${result.created ? " (new)" : ""}`);
    } catch (err) {
      log(`webhook subscription failed: ${(err as Error).message}`);
    }
  } else {
    log("INKBOX_ADMIN_API_KEY not set: subscribe the webhook yourself to " + `${listener.publicUrl}/webhooks/inkbox`);
  }

  return () => listener.close();
}

main().catch((err: Error) => {
  console.error(`[instinct] fatal: ${err.stack ?? err.message}`);
  process.exit(1);
});

import { InkboxProvisioner } from "@open-instinct/inkbox";
import { ensureComputersKey } from "./computersKey.js";
import { ComposioPlatform } from "./composio.js";
import { consoleLogger } from "./logger.js";
import type { LinkPassthrough } from "./provision.js";
import { type GatewayServer, createGateway } from "./server.js";
import { UserStore } from "./store.js";

export const DEFAULT_AGENT_IMAGE = "ghcr.io/mariagorskikh/open-instinct-agent:latest";

export interface GatewayEnv {
  port: number;
  publicUrl: string;
  dataDir: string;
  inkboxAdminApiKey?: string;
  inkboxBaseUrl?: string;
  maritimeApiKey: string;
  maritimeBaseUrl?: string;
  agentImage: string;
  signupSecret?: string;
  /** GATEWAY_ALLOW_OPEN_SIGNUP=1: run the signup form without an invite code. Off by default. */
  allowOpenSignup: boolean;
  /** GATEWAY_TRUST_PROXY=1: rate-limit by X-Forwarded-For (Railway, Fly, a reverse proxy you run). */
  trustProxy: boolean;
  anthropicApiKey?: string;
  composioApiKey?: string;
  composioToolkits?: string;
  /** COMPOSIO_MODE forwarded to each agent: direct or router. Unset lets the agent choose from its model. */
  composioMode?: string;
  contextDevApiKey?: string;
  /** AMPLE_SIGNUP=1: each person's agent signs up for an Ample account of its own on its first deploy. */
  ampleSignup: boolean;
  /** An Ample credential set on the gateway. Never forwarded: every agent would share one account. */
  ampleSharedCredential: boolean;
  idleTtlSeconds?: number;
  useMaritimeLlm: boolean;
  maritimeModel?: string;
  link?: LinkPassthrough;
  /** Directory holding registry/, personas/ and skills/. Default: the templates shipped with the package. */
  templatesDir?: string;
  /** EXECUTOR_MCP_URL: the self-hosted executor MCP endpoint (Composio custom-toolkit app_url). Unset disables the executor. */
  executorMcpUrl?: string;
  /** EXECUTOR_MCP_TOKEN: Bearer sent to the executor on every call. Required with the URL; never forwarded to agents. */
  executorMcpToken?: string;
  /** GATEWAY_ADMIN_TOKEN: bearer for POST /api/admin/desktop/<userId>. Unset disables the endpoint (503). */
  adminToken?: string;
  /** MARITIME_COMPUTERS_API_KEY: operator-minted computers-scoped key; wins over the gateway's own mint. */
  maritimeComputersKey?: string;
  /** GITHUB_TOKEN: fleet fallback for brain pushes into public repos (a person's token always wins). */
  githubToken?: string;
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|yes)$/i.test(v.trim());
}

/**
 * A hung external API must never keep the gateway from listening. On timeout
 * the boot step is treated as failed (executor off / no hosted computer) —
 * both are non-fatal states the gateway is designed to run in.
 */
function withTimeout<T>(label: string, promise: Promise<T>, ms: number, log: { warn: (event: string, fields: Record<string, unknown>) => void }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      log.warn(`${label}_timeout`, { effect: "continuing without it", ms });
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

const BOOT_TIMEOUT_MS = 30_000;

/** The only place the gateway reads process.env. Everything else takes options. */
export function readEnv(env: NodeJS.ProcessEnv): GatewayEnv {
  const port = Number(env["PORT"] ?? 8787);
  const maritimeApiKey = env["MARITIME_API_KEY"];
  if (!maritimeApiKey) throw new Error("MARITIME_API_KEY is required (the gateway forwards every message through Maritime).");
  const publicUrl = env["GATEWAY_PUBLIC_URL"] ?? `http://localhost:${port}`;
  const idle = env["INSTINCT_IDLE_TTL_SECONDS"] ? Number(env["INSTINCT_IDLE_TTL_SECONDS"]) : undefined;
  const linkClientId = env["LINK_CLIENT_ID"] || undefined;
  const link: LinkPassthrough | undefined = linkClientId
    ? {
        clientId: linkClientId,
        ...(env["LINK_CLIENT_SECRET"] ? { clientSecret: env["LINK_CLIENT_SECRET"] } : {}),
        ...(env["STRIPE_PUBLISHABLE_KEY"] ? { stripePublishableKey: env["STRIPE_PUBLISHABLE_KEY"] } : {}),
      }
    : undefined;
  return {
    port,
    publicUrl,
    dataDir: env["GATEWAY_DATA_DIR"] ?? "./.instinct-gateway",
    inkboxAdminApiKey: env["INKBOX_ADMIN_API_KEY"] || undefined,
    inkboxBaseUrl: env["INKBOX_BASE_URL"] || undefined,
    maritimeApiKey,
    maritimeBaseUrl: env["MARITIME_API_URL"] || undefined,
    agentImage: env["INSTINCT_AGENT_IMAGE"] || DEFAULT_AGENT_IMAGE,
    signupSecret: env["GATEWAY_SIGNUP_SECRET"] || undefined,
    allowOpenSignup: truthy(env["GATEWAY_ALLOW_OPEN_SIGNUP"]) || truthy(env["GATEWAY_OPEN_SIGNUP"]),
    trustProxy: truthy(env["GATEWAY_TRUST_PROXY"]),
    anthropicApiKey: env["ANTHROPIC_API_KEY"] || undefined,
    composioApiKey: env["COMPOSIO_API_KEY"] || undefined,
    composioToolkits: env["COMPOSIO_TOOLKITS"] || env["INSTINCT_COMPOSIO_TOOLKITS"] || undefined,
    composioMode: env["COMPOSIO_MODE"]?.trim() || undefined,
    contextDevApiKey: env["CONTEXT_DEV_API_KEY"] || undefined,
    ampleSignup: truthy(env["AMPLE_SIGNUP"]),
    ampleSharedCredential: Boolean(env["AMPLE_CLIENT_ID"] || env["AMPLE_CLIENT_SECRET"] || env["AMPLE_TOKEN"]),
    idleTtlSeconds: idle !== undefined && Number.isFinite(idle) ? idle : undefined,
    useMaritimeLlm: truthy(env["INSTINCT_USE_MARITIME_LLM"]),
    maritimeModel: env["INSTINCT_MARITIME_MODEL"] || undefined,
    link,
    templatesDir: env["GATEWAY_TEMPLATES_DIR"] || undefined,
    executorMcpUrl: env["EXECUTOR_MCP_URL"] || undefined,
    executorMcpToken: env["EXECUTOR_MCP_TOKEN"] || undefined,
    adminToken: env["GATEWAY_ADMIN_TOKEN"] || undefined,
    maritimeComputersKey: env["MARITIME_COMPUTERS_API_KEY"] || undefined,
    githubToken: env["GITHUB_TOKEN"] || undefined,
  };
}

/**
 * Signup provisions an Inkbox identity and a Maritime VM, both billed to the
 * operator. With a provisioner configured the form is live, so it must be
 * behind an invite code unless the operator opts into open signup by name.
 */
export function checkSignupPolicy(cfg: Pick<GatewayEnv, "inkboxAdminApiKey" | "signupSecret" | "allowOpenSignup">): { ok: true; open: boolean } | { ok: false; reason: string } {
  if (!cfg.inkboxAdminApiKey) return { ok: true, open: false };
  if (cfg.signupSecret) return { ok: true, open: false };
  if (cfg.allowOpenSignup) return { ok: true, open: true };
  return {
    ok: false,
    reason:
      "INKBOX_ADMIN_API_KEY is set but GATEWAY_SIGNUP_SECRET is not. Every signup creates a billed identity and VM, so set an invite code, " +
      "or set GATEWAY_ALLOW_OPEN_SIGNUP=1 to run the form open to the internet on purpose.",
  };
}

/** Settings every agent gets. Only keys safe to share across people belong here. */
export function agentExtraEnv(cfg: Pick<GatewayEnv, "contextDevApiKey" | "ampleSignup" | "composioMode">): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (cfg.composioMode) env["COMPOSIO_MODE"] = cfg.composioMode;
  if (cfg.contextDevApiKey) env["CONTEXT_DEV_API_KEY"] = cfg.contextDevApiKey;
  if (cfg.ampleSignup) env["AMPLE_SIGNUP"] = "1";
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Boot: resolve the narrow computers key and register the executor toolkit
 * BEFORE accepting signups, so the first agent is provisioned against ready
 * state. Both failures are non-fatal by design (no hosted computer / no
 * executor) — each is logged loudly and the gateway still comes up.
 */
export async function startGateway(cfg: GatewayEnv): Promise<GatewayServer> {
  const log = consoleLogger;
  const policy = checkSignupPolicy(cfg);
  if (!policy.ok) throw new Error(policy.reason);
  if (policy.open) {
    log.warn("gateway.open_signup", {
      warning: "Signup is open to anyone. Each signup bills your Maritime wallet and Inkbox plan. Set GATEWAY_SIGNUP_SECRET to close it.",
    });
  }

  const store = new UserStore(cfg.dataDir);
  const inkbox = cfg.inkboxAdminApiKey
    ? new InkboxProvisioner({ adminApiKey: cfg.inkboxAdminApiKey, baseUrl: cfg.inkboxBaseUrl })
    : undefined;
  if (!inkbox) log.warn("gateway.relay_only", { reason: "INKBOX_ADMIN_API_KEY not set; signup disabled" });
  if (!cfg.publicUrl.startsWith("https://")) log.warn("gateway.public_url_not_https", { publicUrl: cfg.publicUrl });
  if (cfg.ampleSharedCredential) {
    log.warn("gateway.ample_credential_ignored", {
      reason: "An Ample credential is not forwarded to agents: they would all deploy into one account. Set AMPLE_SIGNUP=1 to give each person an account of their own.",
    });
  }

  // Fleet isolation: agents get a narrow computers-scoped key, never the fleet key.
  const computersKey = await withTimeout(
    "computers_key",
    ensureComputersKey({
      apiKey: cfg.maritimeApiKey,
      baseUrl: cfg.maritimeBaseUrl,
      dataDir: cfg.dataDir,
      override: cfg.maritimeComputersKey,
      logger: log,
    }),
    BOOT_TIMEOUT_MS,
    log,
  ).catch(() => undefined);
  if (computersKey) log.info("computers_key.ready", { source: cfg.maritimeComputersKey ? "override" : "minted" });

  // Executor: all three parts are required (API key, MCP URL, token). A boot
  // failure logs loudly and leaves the gateway running without the executor —
  // template lists that name `custom_executor` are stripped at provision time.
  let composio: ComposioPlatform | undefined;
  if (cfg.composioApiKey && cfg.executorMcpUrl && cfg.executorMcpToken) {
    const platform = new ComposioPlatform(
      { apiKey: cfg.composioApiKey, appUrl: cfg.executorMcpUrl, token: cfg.executorMcpToken },
      { logger: log },
    );
    try {
      await withTimeout("composio_boot", platform.ensureBoot(), BOOT_TIMEOUT_MS, log);
      composio = platform;
    } catch (err) {
      log.error("composio.executor_unavailable", {
        error: err instanceof Error ? err.message : String(err),
        effect: "agents run without the executor (custom_executor stripped from their toolkit list)",
      });
    }
  } else {
    log.warn("composio.executor_disabled", {
      reason: "COMPOSIO_API_KEY, EXECUTOR_MCP_URL and EXECUTOR_MCP_TOKEN must all be set",
    });
  }

  const server = createGateway({
    store,
    publicUrl: cfg.publicUrl,
    inkbox,
    inkboxBaseUrl: cfg.inkboxBaseUrl,
    maritime: {
      apiKey: cfg.maritimeApiKey,
      baseUrl: cfg.maritimeBaseUrl,
      agentImage: cfg.agentImage,
      idleTtlSeconds: cfg.idleTtlSeconds,
      useMaritimeLlm: cfg.useMaritimeLlm,
      maritimeModel: cfg.maritimeModel,
      computersKey,
      extraEnv: agentExtraEnv(cfg),
    },
    signupSecret: cfg.signupSecret,
    anthropicApiKey: cfg.anthropicApiKey,
    composioApiKey: cfg.composioApiKey,
    composioToolkits: cfg.composioToolkits,
    composio,
    githubToken: cfg.githubToken,
    adminToken: cfg.adminToken,
    link: cfg.link,
    trustProxy: cfg.trustProxy,
    templateDir: cfg.templatesDir,
    logger: log,
    // The triage endpoint called with an identity-scoped key answers for that identity, so its QR fits the user.
    routerInfoFor: (user) => new InkboxProvisioner({ adminApiKey: user.identityApiKey, baseUrl: cfg.inkboxBaseUrl }).routerInfo(),
  });
  server.listen(cfg.port, "0.0.0.0", () => {
    log.info("gateway.listening", {
      port: cfg.port,
      publicUrl: cfg.publicUrl,
      users: store.all().length,
      signup: Boolean(inkbox),
      link: Boolean(cfg.link),
      executor: Boolean(composio),
      computer: Boolean(computersKey),
      adminApi: Boolean(cfg.adminToken),
    });
    server.resumePending();
    // Older subscriptions were made before call.ended existed; each boot tops them up.
    void server.backfillWebhookEvents();
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(0), 10_000);
    deadline.unref();
    server.close(() => { void server.drainWebhooks().finally(() => process.exit(0)); });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return server;
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  startGateway(readEnv(process.env)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

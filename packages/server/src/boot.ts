/**
 * Wire one agent process from env + state. This is the only place that decides
 * which optional pieces exist (Inkbox, computer, apps, network) based on what is
 * configured. Everything it builds is returned so main.ts, the smoke test and
 * embedders can drive it the same way.
 */
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  AgentRuntime,
  A2AStore,
  ApprovalStore,
  AuditLog,
  ContactStore,
  MemoryStore,
  PolicyEngine,
  Scheduler,
  StateDir,
  ToolRegistry,
  coreTools,
  ensurePersona,
  loadConfig,
  loadPolicy,
  resolveDataDir,
  resolveModel,
} from "@open-instinct/core";
import type { InboundMessage, InstinctConfig, Outbox, RegisteredTool } from "@open-instinct/core";
import { InkboxA2A, InkboxChannel, InkboxInboundHydrator, InkboxProvisioner, messagingTools, sendFileTool } from "@open-instinct/inkbox";
import { computerGuidance, detectComputer } from "@open-instinct/computer";
import type { ComputerBackend } from "@open-instinct/computer";
import { ComposioApps, DEFAULT_TOOLKITS, appsGuidance, appsTools } from "@open-instinct/apps";
import { ampleTools, type AmpleCredentials } from "@open-instinct/ample";
import { contextTools } from "@open-instinct/context";
import { networkTools } from "@open-instinct/network";
import { ChatAwareOutbox, ConsoleOutbox, type ChatReplyBuffer } from "./console-outbox.js";
import { fileTools, resolveInsideWorkspace } from "./file-tools.js";
import { describeDataPart, promptExtraFor } from "./hooks.js";
import { appsNotConfiguredTool, setupSummaryFor } from "./setup-summary.js";
import { createScheduleSync, type ScheduleSync } from "./maritime-schedules.js";
import { loadPaymentsModule, paymentsEnv, type LinkWalletLike, type PaymentsModule } from "./payments.js";
import { formatSkillsIndex, loadSkillList, loadSkillTool, resolveSkillsDir } from "./skills.js";

export interface BootOptions {
  streamFn?: StreamFn;
  model?: Model<any>;
  outbox?: Outbox;
  logger?: (m: string) => void;
  skillsDir?: string;
  /** Override for tests. Default: real fetch. */
  fetchImpl?: typeof fetch;
  /** Override for tests: the payments module to wire instead of importing @open-instinct/payments. */
  payments?: PaymentsModule;
}

export interface BootResult {
  runtime: AgentRuntime;
  state: StateDir;
  config: InstinctConfig;
  scheduler: Scheduler;
  outbox: Outbox;
  close(): Promise<void>;
  computerKind?: string;
  apps?: ComposioApps;
  /** Toolkits Composio reports as connected at boot, for the status page. */
  appsConnected?: string[];
  startedAt: number;
  modelSpec: string;
  /** Finished chat replies waiting for the next /chat on their conversation. */
  chatBuffer: ChatReplyBuffer;
  /** Set when LINK_CLIENT_ID, LINK_CLIENT_SECRET and STRIPE_PUBLISHABLE_KEY are present and the package is installed. */
  wallet?: LinkWalletLike;
  /** Complete compact Inkbox events before handing them to the runtime. */
  hydrateInbound?: (message: InboundMessage) => Promise<InboundMessage>;
}

export const DEFAULT_MARITIME_MCP_URL = "https://mcp.maritime.sh";

export async function boot(env: NodeJS.ProcessEnv, opts: BootOptions = {}): Promise<BootResult> {
  const log = opts.logger ?? ((m: string) => console.log(`[instinct] ${m}`));
  const startedAt = Date.now();

  const state = new StateDir(resolveDataDir(env));
  state.ensure();
  const config = loadConfig(state, env);
  // PERSONA.md is the owner's file; INSTINCT_PERSONA seeds it on first boot only.
  if (ensurePersona(state, env.INSTINCT_PERSONA)) log(`wrote ${state.path("PERSONA.md")}${env.INSTINCT_PERSONA?.trim() ? " from INSTINCT_PERSONA" : " (default persona)"}`);

  const audit = new AuditLog(state);
  const policy = new PolicyEngine(loadPolicy(state), {
    spentTodayUsd: () => audit.spentTodayUsd(config.owner.timezone),
  });
  const approvals = new ApprovalStore(state);
  const scheduler = new Scheduler(state);
  const contacts = new ContactStore(state);
  const memory = new MemoryStore(state);
  const a2aStore = new A2AStore(state);

  const model = opts.model ?? resolveModel(config.model.primary, env);
  const modelSpec = `${model.provider}/${model.id}`;

  const inkbox = inkboxSettings(env, config);
  const a2a = inkbox ? new InkboxA2A({
    apiKey: inkbox.apiKey,
    handle: inkbox.handle,
    ...(env.INKBOX_BASE_URL ? { baseUrl: env.INKBOX_BASE_URL } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  }) : undefined;
  const externalUserId = inkbox?.handle ?? config.agent.handle ?? "owner";

  // Outbox: Inkbox when configured, else console. A caller-supplied outbox wins (tests).
  // Whatever the transport, `chat` replies are buffered for the HTTP layer: that channel
  // is the dashboard or CLI waiting on a response, not a wire Inkbox can deliver on.
  let channel: InkboxChannel | undefined;
  let outbox: Outbox;
  let chatBuffer: ChatReplyBuffer;
  if (opts.outbox) {
    if (opts.outbox instanceof InkboxChannel) channel = opts.outbox;
    const wrapped = new ChatAwareOutbox(opts.outbox);
    outbox = wrapped;
    chatBuffer = wrapped.chat;
  } else if (inkbox) {
    channel = new InkboxChannel({
      apiKey: inkbox.apiKey,
      handle: inkbox.handle,
      identityId: inkbox.identityId,
      ...(env.INKBOX_BASE_URL ? { baseUrl: env.INKBOX_BASE_URL } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    const wrapped = new ChatAwareOutbox(channel);
    outbox = wrapped;
    chatBuffer = wrapped.chat;
  } else {
    const console_ = new ConsoleOutbox({ logger: log });
    outbox = console_;
    chatBuffer = console_.chat;
    log("Inkbox not configured: replies go to the console outbox");
  }

  const registry = new ToolRegistry();
  const promptSections: string[] = [];

  registry.registerMany(
    coreTools({
      memory,
      scheduler,
      approvals,
      audit,
      config,
      outbox,
      workspaceDir: state.path("workspace"),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(env.BRAVE_SEARCH_API_KEY ? { searchApiKey: env.BRAVE_SEARCH_API_KEY } : {}),
    }),
  );

  if (env.CONTEXT_DEV_API_KEY) {
    registry.registerMany(
      contextTools({
        apiKey: env.CONTEXT_DEV_API_KEY,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    );
  }

  // Messaging needs Inkbox. send_file does not: without a wire it still hands files
  // to the dashboard chat, which is how `instinct chat` and the smoke test get them.
  if (channel) registry.registerMany(messagingTools({ channel, contacts, config, dataDir: state.root }));
  else registry.register(sendFileTool({ contacts, config, dataDir: state.root }));
  const hydrator = channel ? new InkboxInboundHydrator({
    channel,
    mediaDir: state.path("workspace", "inbound"),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  }) : undefined;

  registry.registerMany(fileTools(state.path("workspace"), { env }));

  // Web app deploys through Ample: with the deployer's credential, or with an
  // account this agent signs up for itself on the first deploy (AMPLE_SIGNUP=1),
  // which is how every person behind a shared gateway gets an account of their own.
  const ample = ampleCredentials(env);
  const ampleSignup = !ample && env.AMPLE_SIGNUP === "1";
  if (ample || ampleSignup) {
    const workspace = state.path("workspace");
    const ownerEmail = config.owner.emails[0];
    registry.registerMany(
      ampleTools({
        ...(ample
          ? { credentials: ample }
          : {
              signup: {
                file: state.path("secrets", "ample.json"),
                name: `open-instinct-${config.agent.handle ?? "agent"}`,
                ...(ownerEmail ? { ownerEmail } : {}),
              },
            }),
        workspaceDir: workspace,
        resolvePath: (requested) => resolveInsideWorkspace(workspace, requested),
        env,
        ...(env.AMPLE_API_URL ? { apiUrl: env.AMPLE_API_URL } : {}),
        ...(env.AMPLE_BIN ? { bin: env.AMPLE_BIN } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    );
    log(`ample: web app deploys on (${ample ? "shared credential" : "own account on first deploy"})`);
  }

  // Computer: in-VM desktopd, hosted Maritime Computers MCP, or nothing.
  const computer = await safely(log, "computer", () =>
    detectComputer({
      mode: config.computer.mode,
      desktopdUrl: config.computer.desktopdUrl,
      maritimeMcpUrl: config.computer.maritimeMcpUrl ?? env.MARITIME_COMPUTERS_MCP_URL ?? DEFAULT_MARITIME_MCP_URL,
      maritimeApiKey: env.MARITIME_API_KEY,
      externalUserId,
      // Maritime starts the desktop stack in the background; desktopd may still be coming up.
      expectDesktopd: env.MARITIME_DESKTOP === "1",
      ...(env.MARITIME_AGENT_ID ? { agentId: env.MARITIME_AGENT_ID } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      logger: log,
    }),
  );
  if (computer) {
    const tools = await safely(log, "computer tools", () => computer.tools());
    if (tools && tools.length > 0) {
      registry.registerMany(tools);
      promptSections.push(computerGuidance());
      log(`computer: ${computer.describe()}`);
    }
  }

  // Apps through Composio, when the deployer gave us a key. The key is the switch:
  // config.apps.enabled only records that a toolkit list was seeded. A list of
  // `all` (or `*`) drops the allowlist so any app can be connected by name.
  let apps: ComposioApps | undefined;
  let appsConnected: string[] | undefined;
  if (env.COMPOSIO_API_KEY) {
    const toolkits = config.apps.toolkits.length > 0 ? config.apps.toolkits : DEFAULT_TOOLKITS;
    const composio = new ComposioApps({ apiKey: env.COMPOSIO_API_KEY, userId: externalUserId, toolkits, state, logger: log });
    const connected = await safely(log, "apps", async () => {
      await composio.connect();
      const tools = await composio.tools();
      const status = await composio.connectedToolkits();
      return { tools, status };
    });
    if (connected) {
      apps = composio;
      registry.registerMany(connected.tools);
      registry.registerMany(appsTools({ apps: composio }));
      const on = connected.status.filter((s: ToolkitStatus) => s.connected).map((s: ToolkitStatus) => s.slug);
      const missing = connected.status.filter((s: ToolkitStatus) => !s.connected).map((s: ToolkitStatus) => s.slug);
      appsConnected = on;
      promptSections.push(appsGuidance(on, missing, { anyApp: composio.allToolkits }));
      log(`apps: ${connected.tools.length} tools${composio.allToolkits ? " (any app by name)" : ""}, connected: ${on.join(", ") || "none"}`);
    }
  }
  // No Composio key: the model still gets an apps_connect tool, so "connect my Gmail"
  // produces one precise sentence about what to set up instead of an invented screen.
  if (!apps) registry.register(appsNotConfiguredTool());

  // Trusted network: contacts, tiers, grants, A2A.
  registry.registerMany(
    networkTools({
      contacts,
      policy,
      config,
      audit,
      outbox,
      a2aStore,
      ...(a2a ? { a2a } : {}),
      ...(env.INKBOX_ADMIN_API_KEY
        ? {
            provisioner: new InkboxProvisioner({
              adminApiKey: env.INKBOX_ADMIN_API_KEY,
              ...(env.INKBOX_BASE_URL ? { baseUrl: env.INKBOX_BASE_URL } : {}),
              ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
            }),
          }
        : {}),
    }),
  );

  // Payments: a Stripe Link agent wallet, when the Link OAuth client and Stripe key are set.
  let wallet: LinkWalletLike | undefined;
  const payments = paymentsEnv(env);
  if (payments) {
    const mod = opts.payments ?? (await loadPaymentsModule());
    if (!mod) {
      log("payments: LINK_* set but @open-instinct/payments is not installed; skipping");
    } else {
      const built = await safely(log, "payments", () => {
        const w = new mod.LinkWallet({
          state,
          clientId: payments.clientId,
          clientSecret: payments.clientSecret,
          publishableKey: payments.publishableKey,
          redirectUri: payments.redirectUri,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        });
        return { wallet: w, tools: mod.paymentsTools({ wallet: w, outbox, config, audit, state }) };
      });
      if (built) {
        wallet = built.wallet;
        registry.registerMany(built.tools);
        log(`payments: Link wallet ${wallet.isConnected() ? "connected" : "not connected yet"}, callback ${payments.redirectUri}`);
      }
    }
  }

  const skillsDir = resolveSkillsDir({ explicit: opts.skillsDir, env, packageUrl: import.meta.url });
  const skillList = loadSkillList(skillsDir, log);
  const skills = formatSkillsIndex(skillList);
  if (skills) promptSections.push(skills);
  // Registered even when every skill is hidden: those load by name from a schedule or command.
  if (skillList.length > 0) registry.register(loadSkillTool(skillList));
  const skillsPrompt = promptSections.length > 0 ? promptSections.join("\n\n") : undefined;

  const runtime = new AgentRuntime({
    state,
    config,
    policy,
    approvals,
    audit,
    scheduler,
    contacts,
    memory,
    registry,
    model,
    outbox,
    a2aStore,
    ...(a2a ? { loadA2ATask: (taskId: string) => a2a.getTask(taskId) } : {}),
    skillsPrompt,
    streamFn: opts.streamFn ?? (streamSimple as StreamFn),
    getApiKey: (provider: string) => apiKeyFor(provider, env),
    // Core cannot import the network package; the server bridges OIP and the network guidance.
    describeData: describeDataPart,
    promptExtra: promptExtraFor,
    setupSummary: () =>
      setupSummaryFor({
        inkbox: inkbox ? { handle: inkbox.handle } : undefined,
        computerKind: computer?.kind,
        apps: apps ? { connected: appsConnected ?? [], anyApp: apps.allToolkits, toolkits: apps.toolkitSlugs } : undefined,
        wallet: wallet ? { connected: wallet.isConnected() } : undefined,
      }),
    ...(env.INSTINCT_REPLY_BUDGET_MS ? { replyBudgetMs: Number(env.INSTINCT_REPLY_BUDGET_MS) } : {}),
  });

  const stopScheduler = scheduler.start((entry) => runtime.runScheduled(entry));

  let sync: ScheduleSync | undefined;
  if (env.MARITIME_BACKEND_URL && env.MARITIME_INTERNAL_TOKEN && env.MARITIME_AGENT_ID) {
    sync = createScheduleSync({
      backendUrl: env.MARITIME_BACKEND_URL,
      token: env.MARITIME_INTERNAL_TOKEN,
      agentId: env.MARITIME_AGENT_ID,
      read: () => scheduler.toMaritimeSchedules(),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      logger: log,
    });
    await sync.push(true);
    sync.start();
  }

  log(`agent "${config.agent.name}" ready: model ${modelSpec}, ${registry.all().length} tools, data ${state.root}`);

  return {
    runtime,
    state,
    config,
    scheduler,
    outbox,
    computerKind: computer?.kind,
    apps,
    appsConnected,
    startedAt,
    modelSpec,
    chatBuffer,
    ...(wallet ? { wallet } : {}),
    ...(hydrator ? { hydrateInbound: (message: InboundMessage) => hydrator.hydrate(message) } : {}),
    async close() {
      stopScheduler();
      sync?.stop();
      await safely(log, "computer close", () => computer?.close());
      await safely(log, "apps close", () => apps?.close());
    },
  };
}

interface ToolkitStatus {
  slug: string;
  connected: boolean;
}

/** Env variable per Pi provider id. Anything not listed falls back to <PROVIDER>_API_KEY. */
export const PROVIDER_KEY_ENV: Record<string, string[]> = {
  "anthropic": ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
  "openai": ["OPENAI_API_KEY"],
  "openai-compatible": ["OPENAI_API_KEY"],
  "openai-codex": ["OPENAI_API_KEY"],
  "google": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "google-gemini-cli": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "groq": ["GROQ_API_KEY"],
  "mistral": ["MISTRAL_API_KEY"],
  "xai": ["XAI_API_KEY"],
  "openrouter": ["OPENROUTER_API_KEY"],
  "deepseek": ["DEEPSEEK_API_KEY"],
  "cerebras": ["CEREBRAS_API_KEY"],
  "zai": ["ZAI_API_KEY"],
  "minimax": ["MINIMAX_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  "amazon-bedrock": ["AWS_BEARER_TOKEN_BEDROCK"],
};

/**
 * Provider key from the env the server was handed (not process.env, so tests and
 * embedders control it). Pi would read process.env itself; passing the key keeps
 * the lookup in one place and lets `instinct dev` and embedders inject keys.
 */
export function apiKeyFor(provider: string, env: NodeJS.ProcessEnv): string | undefined {
  const names = PROVIDER_KEY_ENV[provider] ?? [`${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

interface InkboxSettings {
  apiKey: string;
  handle: string;
  identityId?: string;
}

function inkboxSettings(env: NodeJS.ProcessEnv, config: InstinctConfig): InkboxSettings | undefined {
  const apiKey = env.INKBOX_API_KEY;
  const handle = env.INKBOX_AGENT_HANDLE ?? config.agent.handle;
  if (!apiKey || !handle) return undefined;
  return { apiKey, handle, identityId: env.INKBOX_IDENTITY_ID };
}

/** An Ample agent credential (preferred: it never expires) or a plain token. */
export function ampleCredentials(env: NodeJS.ProcessEnv): AmpleCredentials | undefined {
  const clientId = env.AMPLE_CLIENT_ID?.trim();
  const clientSecret = env.AMPLE_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) return { clientId, clientSecret };
  const token = env.AMPLE_TOKEN?.trim();
  return token ? { token } : undefined;
}

/** Optional pieces must never stop the agent from booting. Log and go on. */
async function safely<T>(log: (m: string) => void, what: string, fn: () => Promise<T> | T | undefined): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    log(`${what} unavailable: ${(err as Error).message}`);
    return undefined;
  }
}

export type { RegisteredTool, ComputerBackend };

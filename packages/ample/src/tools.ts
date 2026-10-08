import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineTool, textResult, wrapUntrusted, type RegisteredTool, type ToolResultLike } from "@open-instinct/core";
import { Type } from "typebox";
import { SignupAccount } from "./account.js";
import { AmpleAuth, DEFAULT_API_URL, type AmpleCredentials } from "./auth.js";
import { CliMissingError, cliEnv, spawnCli, type CliResult, type RunCli } from "./cli.js";

/** The CLI waits this long for a build and health check; the process gets a little more. */
const DEPLOY_WAIT_SECS = 600;
const DEPLOY_TIMEOUT_MS = (DEPLOY_WAIT_SECS + 120) * 1000;
const QUICK_TIMEOUT_MS = 120_000;
/** What the model sees of a CLI result. Build logs beyond this are noise in a phone conversation. */
const RESULT_CAP = 12_000;

/** App names become hostnames. Deployment IDs never start with a dash, so neither can become a flag. */
const APP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** ample.toml paths the planner asks about, such as services.web.start. */
const ANSWER_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export interface AmpleToolDeps {
  /** A shared credential from the operator (one person, or a team that shares an account). */
  credentials?: AmpleCredentials;
  /**
   * Without `credentials`: the agent signs up for an Ample account of its own on
   * the first deploy and keeps it in `file`. One account per agent, so per person.
   */
  signup?: { file: string; ownerEmail?: string; name?: string };
  /** The agent's workspace. Deploys only package folders inside it. */
  workspaceDir: string;
  /** Maps a model-supplied path to an absolute path inside the workspace, or undefined to refuse. */
  resolvePath: (requested: string) => string | undefined;
  apiUrl?: string;
  /** The CLI binary. Default `ample` on PATH. */
  bin?: string;
  /** Environment the CLI's PATH and HOME come from. Default process.env. */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Override for tests. */
  run?: RunCli;
}

export function ampleTools(deps: AmpleToolDeps): RegisteredTool[] {
  const apiUrl = (deps.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  let source: ConstructorParameters<typeof AmpleAuth>[0];
  if (deps.credentials) source = { credentials: deps.credentials };
  else if (deps.signup) source = { signup: new SignupAccount({ ...deps.signup, apiUrl, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }) };
  else throw new Error("ampleTools needs credentials or signup");
  const auth = new AmpleAuth(source, apiUrl, deps.fetchImpl);
  const run = deps.run ?? spawnCli(deps.bin ?? "ample");
  const baseEnv = deps.env ?? process.env;

  const once = async (args: string[], timeoutMs: number, signal?: AbortSignal): Promise<AmpleResult> => {
    const { token, notice } = await auth.token(signal);
    const result = await run(["--format", "json", ...args], { env: cliEnv(baseEnv, token, apiUrl), timeoutMs, ...(signal ? { signal } : {}) });
    return notice ? { ...result, notice } : result;
  };
  const ample = async (args: string[], timeoutMs: number, signal?: AbortSignal): Promise<AmpleResult> => {
    const result = await once(args, timeoutMs, signal);
    if (!refusedToken(result)) return result;
    // A cached token outlives its account by up to 15 minutes. Ample refuses it on
    // the first request, before anything changes, so one retry with a fresh token
    // is safe; signing in again finds out whether the account is gone.
    auth.dropToken();
    return once(args, timeoutMs, signal);
  };
  const runner: Runner = { ample, hasAccount: () => auth.hasAccount(), retired: (id) => auth.retired(id), workspaceDir: deps.workspaceDir, resolvePath: deps.resolvePath };
  return [deployTool(runner), logsTool(runner), appsTool(runner), deleteTool(runner)];
}

/** A CLI result, plus anything about the account the owner should hear. */
type AmpleResult = CliResult & { notice?: string };

interface Runner {
  ample: (args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<AmpleResult>;
  /** False only for an agent with its own account mode that has not deployed yet. */
  hasAccount: () => boolean;
  /** An account this agent lost (Ample deleted it unclaimed) and replaced. */
  retired: (accountId: string) => boolean;
  workspaceDir: string;
  resolvePath: (requested: string) => string | undefined;
}

function deployTool({ ample: run, retired, workspaceDir, resolvePath }: Runner): RegisteredTool {
  return defineTool({
    name: "ample_deploy",
    label: "Deploy a web app",
    description:
      "Deploy a folder in the workspace to public HTTPS URLs with Ample: a static site, a Node, Python, Go, Ruby or PHP app, or a project of several services (for example web/ and api/ folders). " +
      "Ample works out what the folder holds (services, databases, start commands), deploys it, and waits until it is live or failed, which can take a few minutes. " +
      "A single app gets the folder name in its URL; a project of several services gets one URL per public service. Running it again releases changes to the same URLs; with nothing changed it returns at once. " +
      "If Ample has open questions, it returns them; answer with `answers` and call again. On failure, read the diagnosis and suggested fix, change the code, and deploy again.",
    parameters: Type.Object({
      path: Type.String({ description: "The app's folder inside the workspace, for example apps/bake-sale. Never the workspace itself." }),
      env: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Secrets the app reads from its environment, such as API keys the owner gave you. Stored encrypted by Ample; never put them in the code.",
        }),
      ),
      answers: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: 'Answers to the plan\'s open questions, keyed by the path each question names, for example {"services.web.start": "node server.js"}.',
        }),
      ),
      force: Type.Optional(Type.Boolean({ description: "Rebuild and restart even when nothing changed. Only to recover an app that is live but misbehaving." })),
    }),
    meta: {
      // Reads the folder and writes ample.toml and Ample's .ample/ state into it. Owner only by default.
      capabilities: ["files.read", "files.write"],
      group: "files",
      describe: (args) => `deploy ${str(args, "path") ?? "an app"} with Ample`,
    },
    execute: async ({ path: requested, env, answers, force }, _ctx, signal) => {
      // A deploy runs several CLI commands; an account notice from the first (a
      // signup, say) must reach the result the agent reads.
      let notice: string | undefined;
      const ample: Runner["ample"] = async (args, timeoutMs, signal) => {
        const result = await run(args, timeoutMs, signal);
        notice ??= result.notice;
        return notice ? { ...result, notice } : result;
      };
      const dir = resolvePath(requested);
      if (!dir) return failed(`Refused: "${requested}" is outside the workspace.`);
      if (isWorkspaceRoot(dir, workspaceDir)) {
        return failed("Refused: put the app in its own folder (for example apps/<name>) and deploy that folder, not the whole workspace.");
      }
      if (!existsSync(dir)) return failed(`There is no folder at "${requested}". Write the app's files first.`);
      if (!APP_NAME.test(path.basename(dir))) {
        return failed(`Rename the folder to lowercase letters, digits and hyphens (for example apps/${slug(path.basename(dir)) || "my-app"}): its name becomes part of the URL.`);
      }
      for (const key of Object.keys(env ?? {})) {
        if (!ENV_NAME.test(key)) return failed(`"${key}" is not a valid environment variable name.`);
      }
      for (const key of Object.keys(answers ?? {})) {
        if (!ANSWER_PATH.test(key)) return failed(`"${key}" is not a plan question path.`);
      }

      const envFile = env && Object.keys(env).length > 0 ? writeEnvFile(env) : undefined;
      try {
        let run: Awaited<ReturnType<typeof attempt>> | undefined;
        for (let pass = 0; pass < 2; pass += 1) {
          // One app at the folder's root deploys under the folder's name, which keeps
          // its URL short. Anything else (several services, or one in a subfolder) is
          // a project: write the plan and let `ample deploy` bring up every service in
          // order. ample deploy only plans by itself when no per-service flag is
          // given, so the plan is written here.
          const shape = await deployShape(ample, dir, answers !== undefined && Object.keys(answers).length > 0, signal);
          if ("error" in shape) return shape.error;
          if (shape.project) {
            const planned = await writePlan(ample, dir, answers ?? {}, signal);
            if (planned) return planned;
          }
          const args = ["deploy", dir, ...(shape.project ? [] : ["--name", path.basename(dir)]), "--wait-secs", String(DEPLOY_WAIT_SECS)];
          if (envFile) args.push("--env-file", envFile.file);
          if (force) args.push("--force");
          run = await attempt(() => ample(args, DEPLOY_TIMEOUT_MS, signal), "deploy");
          if ("error" in run) return run.error;
          // The folder's deploy records point at an account this agent lost (Ample
          // deleted it unclaimed, with its apps). They describe nothing that still
          // exists, so drop them and deploy the folder into the current account.
          if (pass === 0 && boundToRetiredAccount(run.result, dir, retired)) {
            rmSync(path.join(dir, ".ample"), { recursive: true, force: true });
            continue;
          }
          break;
        }
        if (!run || "error" in run) return failed("Ample deploy did not run.");
        return report(run.result, "deploy", (result) => {
          const json = parseJson(result.stdout);
          if (result.exitCode === 0) {
            const urls = liveUrls(json);
            const where = urls.length > 0 ? `Live at ${urls.join(", ")}` : "";
            const lead = json?.["unchanged"] === true ? `No changes since the last deploy. ${where || "Still live."}` : where ? `Deployed. ${where}` : "Deployed.";
            // Ample adds a claim link while nobody owns the account; the account notice already carries one.
            const claim = typeof json?.["claim_url"] === "string" && !result.notice ? json["claim_url"] : undefined;
            return claim
              ? `${lead}\nThe owner has not claimed this Ample account yet; it is deleted two days after signup unless they do. Send this link only if they have not had one today: ${claim}`
              : lead;
          }
          if (result.exitCode === 2) return "Ample needs a decision before it can deploy. The result says what to answer or change.";
          return "The deploy failed. The result says who needs to act and how to fix it.";
        });
      } finally {
        envFile?.remove();
      }
    },
  });
}

/** A deploy refused because the folder belongs to an account this agent no longer has. */
function boundToRetiredAccount(result: CliResult, dir: string, retired: (accountId: string) => boolean): boolean {
  const code = (parseJson(result.stdout)?.["error"] as Record<string, unknown> | undefined)?.["code"];
  if (code !== "project_account_mismatch") return false;
  try {
    const bound = JSON.parse(readFileSync(path.join(dir, ".ample", "account.json"), "utf8")) as { account_id?: unknown };
    return typeof bound.account_id === "string" && retired(bound.account_id);
  } catch {
    return false;
  }
}

/**
 * Whether a folder deploys as one app or as a planned project. A folder that has
 * a plan stays a project and one deployed before as an app stays an app; a new
 * folder is planned offline (nothing written) and counted. Answers only exist
 * for a plan, so they make it a project.
 */
async function deployShape(
  ample: Runner["ample"],
  dir: string,
  hasAnswers: boolean,
  signal?: AbortSignal,
): Promise<{ project: boolean } | { error: ToolResultLike }> {
  if (hasAnswers || existsSync(path.join(dir, "ample.toml"))) return { project: true };
  if (existsSync(path.join(dir, ".ample"))) return { project: false };
  const run = await attempt(() => ample(["plan", dir, "--offline"], QUICK_TIMEOUT_MS, signal), "plan");
  if ("error" in run) return run;
  if (run.result.exitCode !== 0 && run.result.exitCode !== 2) {
    return { error: report(run.result, "plan", () => "Ample could not plan this folder.") };
  }
  const services = parseJson(run.result.stdout)?.["services"];
  const single = Array.isArray(services) && services.length === 1 && (services[0] as Record<string, unknown> | undefined)?.["path"] === ".";
  return { project: !single };
}

/** Write ample.toml if missing and apply answers. Returns a result only when the plan still has questions or failed. */
async function writePlan(ample: Runner["ample"], dir: string, answers: Record<string, string>, signal?: AbortSignal): Promise<ToolResultLike | undefined> {
  const steps: string[][] = [];
  if (!existsSync(path.join(dir, "ample.toml"))) steps.push(["plan", dir, "--write"]);
  const answerArgs = Object.entries(answers).flatMap(([key, value]) => ["--answer", `${key}=${value}`]);
  if (answerArgs.length > 0) steps.push(["plan", dir, ...answerArgs]);
  let last: CliResult | undefined;
  for (const args of steps) {
    const run = await attempt(() => ample(args, QUICK_TIMEOUT_MS, signal), "plan");
    if ("error" in run) return run.error;
    last = run.result;
    if (last.exitCode !== 0 && last.exitCode !== 2) return report(last, "plan", () => "Ample could not plan this folder.");
  }
  if (last?.exitCode === 2) {
    return report(last, "plan", () =>
      "The plan has open questions. Answer them with `answers` (the path each question names) or change the code, then call ample_deploy again.",
    );
  }
  return undefined;
}

function logsTool({ ample, hasAccount }: Runner): RegisteredTool {
  return defineTool({
    name: "ample_logs",
    label: "Read app logs",
    description: "Read an Ample app's build or runtime logs by deployment ID (dep_...). Use after a failed deploy, or when a live app misbehaves.",
    parameters: Type.Object({
      deployment_id: Type.String({ description: "The deployment ID from ample_deploy or ample_apps." }),
      kind: Type.Optional(Type.Union([Type.Literal("build"), Type.Literal("runtime"), Type.Literal("all")])),
      tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Last N lines. Default 100." })),
    }),
    meta: { capabilities: ["files.read"], group: "files", describe: (args) => `read Ample logs for ${str(args, "deployment_id") ?? "an app"}` },
    execute: async ({ deployment_id, kind, tail }, _ctx, signal) => {
      if (!DEPLOYMENT_ID.test(deployment_id)) return failed(`"${deployment_id}" is not a deployment ID.`);
      if (!hasAccount()) return failed("Nothing has been deployed with Ample yet, so there are no logs.");
      const args = ["logs", deployment_id, "--kind", kind ?? "all", "--tail", String(tail ?? 100)];
      return runAndReport(() => ample(args, QUICK_TIMEOUT_MS, signal), "logs", (r) => (r.exitCode === 0 ? "Logs:" : "Could not read the logs."));
    },
  });
}

function appsTool({ ample, hasAccount }: Runner): RegisteredTool {
  return defineTool({
    name: "ample_apps",
    label: "List deployed apps",
    description: "List the apps deployed with Ample: name, deployment ID, status and URL.",
    parameters: Type.Object({}),
    meta: { capabilities: ["files.read"], group: "files", describe: () => "list Ample apps" },
    execute: async (_args, _ctx, signal) =>
      !hasAccount()
        ? textResult("No apps yet: nothing has been deployed with Ample.")
        : runAndReport(() => ample(["app", "list"], QUICK_TIMEOUT_MS, signal), "apps", (r) => (r.exitCode === 0 ? "Apps:" : "Could not list the apps.")),
  });
}

function deleteTool({ ample, hasAccount }: Runner): RegisteredTool {
  return defineTool({
    name: "ample_app_delete",
    label: "Delete a deployed app",
    description: "Take an Ample app offline and delete its releases. Its URL stops working. Only when the owner has asked for this app to be removed.",
    parameters: Type.Object({ deployment_id: Type.String({ description: "The deployment ID (dep_...) from ample_apps." }) }),
    meta: { capabilities: ["files.read", "files.write"], group: "files", describe: (args) => `delete Ample app ${str(args, "deployment_id") ?? ""}`.trim() },
    execute: async ({ deployment_id }, _ctx, signal) => {
      if (!DEPLOYMENT_ID.test(deployment_id)) return failed(`"${deployment_id}" is not a deployment ID.`);
      if (!hasAccount()) return failed("Nothing has been deployed with Ample yet, so there is nothing to delete.");
      return runAndReport(() => ample(["app", "delete", deployment_id, "--yes"], QUICK_TIMEOUT_MS, signal), "delete", (r) =>
        r.exitCode === 0 ? "Deleted. The URL no longer serves the app." : "Could not delete the app.",
      );
    },
  });
}

/** The CLI's report of a token Ample would not accept: revoked, or its account deleted or expired. */
function refusedToken(result: CliResult): boolean {
  if (result.exitCode === 0) return false;
  if (parseJson(result.stdout)?.["http_status"] === 401) return true;
  return /\b(authentication_failed|credential_revoked|token_revoked|account_inactive)\b/.test(`${result.stdout}\n${result.stderr}`);
}

/** Run the CLI, turning a missing binary, a failed sign-in or a timeout into a tool error. */
async function attempt(call: () => Promise<AmpleResult>, what: string): Promise<{ result: AmpleResult } | { error: ToolResultLike }> {
  let result: AmpleResult;
  try {
    result = await call();
  } catch (error) {
    if (error instanceof CliMissingError) return { error: failed(`${error.message} Install it with: curl -fsSL https://get.ample.computer/install.sh | sh`) };
    return { error: failed(`Ample ${what} could not run: ${error instanceof Error ? error.message : String(error)}`) };
  }
  if (result.timedOut) {
    return { error: failed(`Ample ${what} did not finish in time. Check ample_apps before trying again; the deploy may still have gone live.`) };
  }
  return { result };
}

/**
 * One message per CLI result: a plain lead line the model can relay, then the
 * CLI's own output as data. Output can quote build logs and app output, so it is
 * wrapped as untrusted.
 */
function report(result: AmpleResult, what: string, lead: (result: AmpleResult) => string): ToolResultLike {
  const output = clip(result.stdout.trim() || result.stderr.trim() || "(no output)");
  const notice = result.notice ? `\n${result.notice}` : "";
  const text = `${lead(result)}${notice}\n${wrapUntrusted(output, `Ample ${what} result`)}`;
  return result.exitCode === 0 ? textResult(text) : { content: [{ type: "text", text }], isError: true };
}

async function runAndReport(call: () => Promise<AmpleResult>, what: string, lead: (result: AmpleResult) => string): Promise<ToolResultLike> {
  const run = await attempt(call, what);
  return "error" in run ? run.error : report(run.result, what, lead);
}

/**
 * Secrets go to the CLI in a dotenv file rather than as --env flags: a planned
 * project only takes them from a file, and flags would show in the process list.
 * The file lives outside the workspace and is removed after the run.
 */
function writeEnvFile(env: Record<string, string>): { file: string; remove: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "ample-env-"));
  const file = path.join(dir, "deploy.env");
  const quote = (value: string) =>
    `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
  writeFileSync(file, Object.entries(env).map(([key, value]) => `${key}=${quote(value)}\n`).join(""), { mode: 0o600 });
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The public URLs in a deploy result: one app's `url`, or every service's in a project. */
function liveUrls(json: Record<string, unknown> | undefined): string[] {
  if (!json) return [];
  if (typeof json["url"] === "string" && json["url"]) return [json["url"]];
  const urls = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || !value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "url" && typeof child === "string" && /^https:\/\//.test(child)) urls.add(child);
      else visit(child, depth + 1);
    }
  };
  visit(json, 0);
  return [...urls];
}

function isWorkspaceRoot(dir: string, workspaceDir: string): boolean {
  try {
    return realpathSync(dir) === realpathSync(workspaceDir);
  } catch {
    return path.resolve(dir) === path.resolve(workspaceDir);
  }
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Keep the head (status, URL, diagnosis) and the tail (last log lines); drop the middle. */
function clip(text: string): string {
  if (text.length <= RESULT_CAP) return text;
  const half = RESULT_CAP / 2;
  return `${text.slice(0, half)}\n... (${text.length - RESULT_CAP} characters omitted) ...\n${text.slice(-half)}`;
}

function str(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function failed(text: string): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true };
}

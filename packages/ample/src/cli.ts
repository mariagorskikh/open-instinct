/**
 * Runs the `ample` CLI. The CLI owns packaging, build detection and the deploy
 * contract (exit 0 live, 1 failed, 2 needs input), so this package drives it
 * instead of reimplementing the upload protocol.
 */
import { spawn } from "node:child_process";

export interface CliResult {
  /** Null when the process was killed (timeout or abort). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type RunCli = (args: string[], opts: RunOptions) => Promise<CliResult>;

/** Enough for any JSON result and a build log tail; the rest is dropped, not buffered. */
const OUTPUT_CAP = 256 * 1024;
const KILL_GRACE_MS = 5_000;

export class CliMissingError extends Error {
  constructor(bin: string) {
    super(`The Ample CLI (${bin}) is not installed on this machine.`);
  }
}

export function spawnCli(bin: string): RunCli {
  return (args, { env, timeoutMs, signal }) =>
    new Promise((resolve, reject) => {
      // stdin is closed so a prompt the CLI might show can never hang the agent.
      const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;

      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        if (stdout.length < OUTPUT_CAP) stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        if (stderr.length < OUTPUT_CAP) stderr += chunk;
      });

      const stop = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      signal?.addEventListener("abort", stop, { once: true });

      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(error.code === "ENOENT" ? new CliMissingError(bin) : error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", stop);
        resolve({ exitCode: code, stdout, stderr, timedOut });
      });
    });
}

/**
 * The CLI's environment: a credential for this one run and nothing else from the
 * agent's process. AMPLE_CONFIG_PATH points at an empty file so a config written
 * by the owner's shell (same uid) cannot redirect the CLI or swap its account.
 */
export function cliEnv(base: NodeJS.ProcessEnv, token: string, apiUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "LANG", "TZ", "TMPDIR"]) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  env.AMPLE_TOKEN = token;
  env.AMPLE_API_URL = apiUrl;
  env.AMPLE_CONFIG_PATH = "/dev/null";
  env.NO_COLOR = "1";
  return env;
}

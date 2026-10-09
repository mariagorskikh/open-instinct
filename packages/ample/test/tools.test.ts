import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ampleTools, spawnCli, type CliResult, type RunCli } from "../src/index.js";

const ctx = {
  principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Owner" } as const,
  conversationKey: "chat:test",
  channel: "chat" as const,
  now: () => new Date("2026-10-07T00:00:00Z"),
};

type Tool = ReturnType<typeof ampleTools>[number];
type Result = Awaited<ReturnType<Tool["spec"]["execute"]>>;

function text(result: Result): string {
  if (typeof result === "string") return result;
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function workspace(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ample-ws-")));
  mkdirSync(path.join(dir, "apps", "bake-sale"), { recursive: true });
  mkdirSync(path.join(dir, "apps", "Bake Sale"), { recursive: true });
  return dir;
}

/** The server's guard, reduced: resolve inside the workspace or refuse. */
function resolver(root: string) {
  return (requested: string) => {
    const target = path.resolve(root, requested);
    return target === root || target.startsWith(root + path.sep) ? target : undefined;
  };
}

function tokenFetch(ttl = 900) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ access_token: `access-${Math.random()}`, expires_in: ttl, token_type: "Bearer" }), { status: 200 }),
  );
}

function fakeRun(result: Partial<CliResult>) {
  return vi.fn<RunCli>(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, ...result }));
}

const ONE_APP = JSON.stringify({ status: "ready", services: [{ name: "bake-sale", path: "." }], questions: [] });
const TWO_SERVICES = JSON.stringify({ status: "ready", services: [{ name: "api", path: "api" }, { name: "web", path: "web" }], questions: [] });

/** A CLI that answers `plan` and `deploy` differently, as the real one does. */
function scriptedRun(answers: { plan?: Partial<CliResult>; write?: Partial<CliResult>; answer?: Partial<CliResult>; deploy?: Partial<CliResult> }, seen?: (args: string[]) => void) {
  return vi.fn<RunCli>(async (args) => {
    seen?.(args);
    const command = args[2];
    const pick =
      command === "plan"
        ? args.includes("--offline")
          ? answers.plan
          : args.includes("--write")
            ? answers.write
            : answers.answer
        : answers.deploy;
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...pick };
  });
}

function tools(opts: { run: RunCli; fetchImpl?: typeof fetch; root?: string; credentials?: { token: string } | { clientId: string; clientSecret: string } }) {
  const root = opts.root ?? workspace();
  const list = ampleTools({
    credentials: opts.credentials ?? { clientId: "agent_test", clientSecret: "client-secret-value" },
    workspaceDir: root,
    resolvePath: resolver(root),
    env: { PATH: "/usr/bin", HOME: "/home/instinct", ANTHROPIC_API_KEY: "sk-ant-secret", INKBOX_API_KEY: "ik_secret" },
    fetchImpl: (opts.fetchImpl ?? tokenFetch()) as typeof fetch,
    run: opts.run,
  });
  const byName = (name: string) => list.find((t) => t.spec.name === name)!;
  return { root, deploy: byName("ample_deploy"), logs: byName("ample_logs"), apps: byName("ample_apps"), del: byName("ample_app_delete") };
}

describe("ample_deploy", () => {
  it("deploys a one-app folder under its own name with a short-lived token that only the CLI sees", async () => {
    const fetchImpl = tokenFetch();
    let envFile = "";
    let envFileBody = "";
    const run = scriptedRun(
      {
        plan: { stdout: ONE_APP },
        deploy: { stdout: JSON.stringify({ status: "live", unchanged: false, url: "https://bake-sale-acc-1.apps.ample.computer", deployment_id: "dep_1" }) },
      },
      (args) => {
        const at = args.indexOf("--env-file");
        if (at >= 0) {
          envFile = args[at + 1]!;
          envFileBody = readFileSync(envFile, "utf8");
        }
      },
    );
    const { root, deploy } = tools({ run, fetchImpl });
    const dir = path.join(root, "apps", "bake-sale");

    const result = await deploy.spec.execute({ path: "apps/bake-sale", env: { STRIPE_KEY: 'sk "live"\\x\ny' } }, ctx);

    expect(deploy.spec.meta.capabilities).toEqual(["files.read", "files.write"]);
    expect(text(result)).toMatch(/^Deployed\. Live at https:\/\/bake-sale-acc-1\.apps\.ample\.computer/);
    expect(text(result)).toContain('<untrusted source="Ample deploy result">');

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.ample.computer/oauth/token");
    const form = new URLSearchParams(String(init!.body));
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("resource")).toBe("https://api.ample.computer/mcp");

    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["--format", "json", "plan", dir, "--offline"],
      ["--format", "json", "deploy", dir, "--name", "bake-sale", "--wait-secs", "600", "--env-file", envFile],
    ]);
    // Secrets travel in a private dotenv file, never on the command line, and the file is gone afterwards.
    expect(envFileBody).toBe('STRIPE_KEY="sk \\"live\\"\\\\x\\ny"\n');
    expect(envFile.startsWith(root)).toBe(false);
    expect(existsSync(envFile)).toBe(false);
    for (const [args] of run.mock.calls) expect(args.join(" ")).not.toContain("sk ");

    const [, opts] = run.mock.calls[1]!;
    expect(opts.env.AMPLE_TOKEN).toMatch(/^access-/);
    expect(opts.env.AMPLE_API_URL).toBe("https://api.ample.computer");
    expect(opts.env.AMPLE_CONFIG_PATH).toBe("/dev/null");
    expect(Object.keys(opts.env).sort()).toEqual(["AMPLE_API_URL", "AMPLE_CONFIG_PATH", "AMPLE_TOKEN", "HOME", "NO_COLOR", "PATH"]);
  });

  it("plans a folder of several services as a project and reports every URL", async () => {
    const deployed = { status: "live", services: { api: { url: "https://p-1-api.apps.ample.computer" }, web: { url: "https://p-1-web.apps.ample.computer" } } };
    const run = scriptedRun({ plan: { stdout: TWO_SERVICES }, write: { stdout: TWO_SERVICES }, deploy: { stdout: JSON.stringify(deployed) } });
    const { root, deploy } = tools({ run });
    const dir = path.join(root, "apps", "bake-sale");

    const result = await deploy.spec.execute({ path: "apps/bake-sale" }, ctx);

    expect(run.mock.calls.map(([args]) => args.slice(2))).toEqual([
      ["plan", dir, "--offline"],
      ["plan", dir, "--write"],
      ["deploy", dir, "--wait-secs", "600"],
    ]);
    expect(text(result)).toMatch(/^Deployed\. Live at https:\/\/p-1-api\.apps\.ample\.computer, https:\/\/p-1-web\.apps\.ample\.computer/);
  });

  it("returns the plan's open questions without deploying, then applies answers", async () => {
    const questions = JSON.stringify({ status: "needs_input", questions: [{ path: "services.api.start", question: "How does api start?" }] });
    const run = scriptedRun({ plan: { stdout: TWO_SERVICES }, write: { exitCode: 2, stdout: questions }, deploy: { stdout: "{}" } });
    const { root, deploy } = tools({ run });
    const dir = path.join(root, "apps", "bake-sale");

    const asked = await deploy.spec.execute({ path: "apps/bake-sale" }, ctx);
    expect(asked).toMatchObject({ isError: true });
    expect(text(asked)).toContain("open questions");
    expect(text(asked)).toContain("services.api.start");
    expect(run.mock.calls.some(([args]) => args[2] === "deploy")).toBe(false);

    // The real CLI writes ample.toml even when it has questions.
    writeFileSync(path.join(dir, "ample.toml"), "version = 1\n");
    run.mockClear();
    await deploy.spec.execute({ path: "apps/bake-sale", answers: { "services.api.start": "node server.js" } }, ctx);
    expect(run.mock.calls.map(([args]) => args.slice(2))).toEqual([
      ["plan", dir, "--answer", "services.api.start=node server.js"],
      ["deploy", dir, "--wait-secs", "600"],
    ]);
  });

  it("keeps a folder deployed before as an app, without planning", async () => {
    const run = scriptedRun({ deploy: { stdout: JSON.stringify({ status: "live", unchanged: true, url: "https://x.apps.ample.computer" }) } });
    const { root, deploy } = tools({ run });
    mkdirSync(path.join(root, "apps", "bake-sale", ".ample"));
    const result = await deploy.spec.execute({ path: "apps/bake-sale", force: true }, ctx);
    expect(text(result)).toMatch(/^No changes since the last deploy\. Live at https:\/\/x\.apps\.ample\.computer/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].slice(2)).toEqual(["deploy", path.join(root, "apps", "bake-sale"), "--name", "bake-sale", "--wait-secs", "600", "--force"]);
  });

  it("returns a failed deploy as an error with Ample's diagnosis", async () => {
    const failure = { error: { code: "health_check_failed", details: { owner: "app", diagnosis: "MAILER_KEY is not set", suggested_fix: "ample deploy --env MAILER_KEY=<value>" } } };
    const { deploy } = tools({ run: scriptedRun({ plan: { stdout: ONE_APP }, deploy: { exitCode: 1, stdout: JSON.stringify(failure) } }) });
    const result = await deploy.spec.execute({ path: "apps/bake-sale" }, ctx);
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toContain("The deploy failed.");
    expect(text(result)).toContain("MAILER_KEY is not set");
  });

  it("refuses paths outside the workspace, the workspace itself, missing folders and bad names", async () => {
    const run = fakeRun({});
    const { root, deploy } = tools({ run });
    symlinkSync(root, path.join(root, "apps", "loop"));

    expect(text(await deploy.spec.execute({ path: "../etc" }, ctx))).toContain("outside the workspace");
    expect(text(await deploy.spec.execute({ path: "." }, ctx))).toContain("its own folder");
    expect(text(await deploy.spec.execute({ path: "apps/loop" }, ctx))).toContain("its own folder");
    expect(text(await deploy.spec.execute({ path: "apps/nope" }, ctx))).toContain("no folder");
    expect(text(await deploy.spec.execute({ path: "apps/Bake Sale" }, ctx))).toContain("apps/bake-sale");
    expect(text(await deploy.spec.execute({ path: "apps/bake-sale", env: { "A=B": "x" } }, ctx))).toContain("not a valid environment variable");
    expect(text(await deploy.spec.execute({ path: "apps/bake-sale", answers: { "--force": "x" } }, ctx))).toContain("not a plan question path");
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a missing CLI with the install command", async () => {
    const { deploy } = tools({ run: spawnCli("/nonexistent/ample") });
    const result = await deploy.spec.execute({ path: "apps/bake-sale" }, ctx);
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toContain("get.ample.computer/install.sh");
  });

  it("never echoes the token endpoint's response or the secret on a failed sign-in", async () => {
    const fetchImpl = vi.fn(async () => new Response("invalid_client client-secret-value", { status: 401 }));
    const run = fakeRun({});
    const { deploy } = tools({ run, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await deploy.spec.execute({ path: "apps/bake-sale" }, ctx);
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toContain("HTTP 401");
    expect(text(result)).not.toContain("client-secret-value");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("tokens", () => {
  it("reuses an access token until it is close to expiry", async () => {
    const fetchImpl = tokenFetch(900);
    const { apps, logs } = tools({ run: fakeRun({ stdout: "[]" }), fetchImpl });
    await apps.spec.execute({}, ctx);
    await logs.spec.execute({ deployment_id: "dep_1" }, ctx);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("renews a token that would expire within a minute", async () => {
    const fetchImpl = tokenFetch(30);
    const { apps } = tools({ run: fakeRun({ stdout: "[]" }), fetchImpl });
    await apps.spec.execute({}, ctx);
    await apps.spec.execute({}, ctx);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("passes a plain AMPLE_TOKEN through without a token exchange", async () => {
    const fetchImpl = tokenFetch();
    const run = fakeRun({ stdout: "[]" });
    const { apps } = tools({ run, fetchImpl, credentials: { token: "tok_plain" } });
    await apps.spec.execute({}, ctx);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(run.mock.calls[0]![1].env.AMPLE_TOKEN).toBe("tok_plain");
  });
});

describe("logs, apps and delete", () => {
  it("reads logs with bounded arguments and refuses IDs that look like flags", async () => {
    const run = fakeRun({ stdout: JSON.stringify([{ message: "listening on 8080" }]) });
    const { logs } = tools({ run });
    const result = await logs.spec.execute({ deployment_id: "dep_1", kind: "runtime", tail: 50 }, ctx);
    expect(text(result)).toContain("listening on 8080");
    expect(run.mock.calls[0]![0]).toEqual(["--format", "json", "logs", "dep_1", "--kind", "runtime", "--tail", "50"]);
    expect(text(await logs.spec.execute({ deployment_id: "--follow" }, ctx))).toContain("not a deployment ID");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("lists apps and deletes one with --yes", async () => {
    const run = fakeRun({ stdout: JSON.stringify({ deployment_id: "dep_1", status: "deleted" }) });
    const { apps, del } = tools({ run });
    await apps.spec.execute({}, ctx);
    const result = await del.spec.execute({ deployment_id: "dep_1" }, ctx);
    expect(run.mock.calls[0]![0]).toEqual(["--format", "json", "app", "list"]);
    expect(run.mock.calls[1]![0]).toEqual(["--format", "json", "app", "delete", "dep_1", "--yes"]);
    expect(text(result)).toMatch(/^Deleted\./);
    expect(del.spec.meta.capabilities).toEqual(["files.read", "files.write"]);
  });

  it("clips long output but keeps its head and tail", async () => {
    const long = `HEAD${"x".repeat(50_000)}TAIL`;
    const { logs } = tools({ run: fakeRun({ stdout: long }) });
    const out = text(await logs.spec.execute({ deployment_id: "dep_1" }, ctx));
    expect(out).toContain("HEAD");
    expect(out).toContain("TAIL");
    expect(out).toContain("characters omitted");
    expect(out.length).toBeLessThan(14_000);
  });
});

describe("spawnCli", () => {
  it("returns exit code and output, and kills a run that times out", async () => {
    const run = spawnCli(process.execPath);
    const ok = await run(["-e", "process.stdout.write('{\"ok\":true}'); process.exit(2)"], { env: {}, timeoutMs: 10_000 });
    expect(ok).toMatchObject({ exitCode: 2, stdout: '{"ok":true}', timedOut: false });
    const slow = await run(["-e", "setTimeout(() => {}, 60_000)"], { env: {}, timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    expect(slow.exitCode).toBeNull();
  });
});

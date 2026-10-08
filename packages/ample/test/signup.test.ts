import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ampleTools, type CliResult, type RunCli } from "../src/index.js";

const ctx = {
  principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Owner" } as const,
  conversationKey: "chat:test",
  channel: "chat" as const,
  now: () => new Date("2026-10-08T00:00:00Z"),
};

type Tool = ReturnType<typeof ampleTools>[number];
function text(result: Awaited<ReturnType<Tool["spec"]["execute"]>>): string {
  if (typeof result === "string") return result;
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

const ONE_APP = JSON.stringify({ status: "ready", services: [{ name: "party", path: "." }] });

/** A fake Ample API: signup, claim email and token exchange, counting calls. */
function fakeAmple(opts: { signupStatus?: number; deletedClients?: Set<string> } = {}) {
  let accounts = 0;
  const calls: Array<{ url: string; body: string; auth?: string }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
    calls.push({ url, body, ...(auth ? { auth } : {}) });
    if (url.endsWith("/v1/auth/signup")) {
      if (opts.signupStatus) return new Response("{}", { status: opts.signupStatus });
      accounts += 1;
      return Response.json({
        account_id: `acc_${accounts}`,
        access_token: `signup-token-${accounts}`,
        credentials: { client_id: `agent_${accounts}`, client_secret: `ample_agent_secret_${accounts}` },
        claim_url: `https://ample.computer/claim?token=ample_claim_${accounts}`,
        account_expires_at: "2026-10-10T00:00:00Z",
      });
    }
    if (url.endsWith("/v1/auth/claim")) return Response.json({ email: "maya@example.com", email_sent: true });
    if (url.endsWith("/oauth/token")) {
      const clientId = new URLSearchParams(body).get("client_id")!;
      if (opts.deletedClients?.has(clientId)) {
        return new Response(JSON.stringify({ error: "invalid_client", error_description: "Invalid client credentials" }), { status: 401 });
      }
      return Response.json({ access_token: `access-for-${clientId}`, expires_in: 900 });
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl, calls, count: (suffix: string) => calls.filter((c) => c.url.endsWith(suffix)).length };
}

function setup(api: ReturnType<typeof fakeAmple>, run?: RunCli, ownerEmail = "maya@example.com") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ample-signup-")));
  const workspace = path.join(root, "workspace");
  mkdirSync(path.join(workspace, "apps", "party"), { recursive: true });
  const file = path.join(root, "secrets", "ample.json");
  const runner =
    run ??
    vi.fn<RunCli>(async (args) => {
      const result: CliResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      if (args[2] === "plan") return { ...result, stdout: ONE_APP };
      return { ...result, stdout: JSON.stringify({ status: "live", url: "https://party-acc-1.apps.ample.computer" }) };
    });
  const tools = ampleTools({
    signup: { file, name: "open-instinct-maya", ...(ownerEmail ? { ownerEmail } : {}) },
    workspaceDir: workspace,
    resolvePath: (p) => path.resolve(workspace, p),
    fetchImpl: api.fetchImpl as unknown as typeof fetch,
    run: runner,
  });
  const byName = (name: string) => tools.find((t) => t.spec.name === name)!;
  return { file, run: runner, deploy: byName("ample_deploy"), apps: byName("ample_apps"), logs: byName("ample_logs") };
}

describe("an Ample account of the agent's own", () => {
  it("signs up on the first deploy, emails the owner a claim link, and hands the agent the link", async () => {
    const api = fakeAmple();
    const { file, run, deploy } = setup(api);

    const result = await deploy.spec.execute({ path: "apps/party" }, ctx);

    const out = text(result);
    expect(out).toMatch(/^Deployed\. Live at https:\/\/party-acc-1\.apps\.ample\.computer/);
    expect(out).toContain("Created an Ample account");
    expect(out).toContain("https://ample.computer/claim?token=ample_claim_1");
    expect(out).toContain("emailed a claim link to maya@example.com");

    const signup = api.calls.find((c) => c.url.endsWith("/v1/auth/signup"))!;
    const body = JSON.parse(signup.body);
    expect(body.name).toBe("open-instinct-maya");
    expect(body.request_key).toMatch(/^[0-9a-f-]{36}$/);
    const claim = api.calls.find((c) => c.url.endsWith("/v1/auth/claim"))!;
    expect(claim.auth).toBe("Bearer signup-token-1");
    expect(JSON.parse(claim.body)).toEqual({ email: "maya@example.com" });

    // The account is kept privately; the CLI only ever sees a short-lived token.
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(stored.account).toMatchObject({ accountId: "acc_1", clientId: "agent_1", clientSecret: "ample_agent_secret_1", claimEmailedTo: "maya@example.com" });
    expect(stored.pending).toBeUndefined();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const [args, opts] of vi.mocked(run).mock.calls) {
      expect(args.join(" ")).not.toContain("ample_agent_secret_1");
      expect(opts.env.AMPLE_TOKEN).toBe("access-for-agent_1");
    }
  });

  it("reuses the account afterwards, without another signup or notice", async () => {
    const api = fakeAmple();
    const { deploy } = setup(api);
    await deploy.spec.execute({ path: "apps/party" }, ctx);
    const second = text(await deploy.spec.execute({ path: "apps/party" }, ctx));
    expect(api.count("/v1/auth/signup")).toBe(1);
    expect(second).not.toContain("Created an Ample account");
  });

  it("does not sign up just to list apps or read logs", async () => {
    const api = fakeAmple();
    const { apps, logs, run } = setup(api);
    expect(text(await apps.spec.execute({}, ctx))).toContain("No apps yet");
    expect(text(await logs.spec.execute({ deployment_id: "dep_1" }, ctx))).toContain("Nothing has been deployed");
    expect(api.fetchImpl).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("signs up again when Ample deleted the unclaimed account, and says the old sites are gone", async () => {
    const deleted = new Set<string>();
    const api = fakeAmple({ deletedClients: deleted });
    // The API refuses tokens of a deleted account, as the CLI reports it.
    const run = vi.fn<RunCli>(async (args, opts) => {
      const ok: CliResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      if (opts.env.AMPLE_TOKEN === "access-for-agent_1" && deleted.has("agent_1")) {
        return { ...ok, exitCode: 1, stderr: "Error: authentication_failed: Missing or invalid Authorization header" };
      }
      if (args[2] === "plan") return { ...ok, stdout: ONE_APP };
      return { ...ok, stdout: JSON.stringify({ status: "live", url: "https://party-acc-2.apps.ample.computer" }) };
    });
    const { file, deploy } = setup(api, run);
    await deploy.spec.execute({ path: "apps/party" }, ctx);
    deleted.add("agent_1");

    const out = text(await deploy.spec.execute({ path: "apps/party" }, ctx));

    expect(out).toContain("previous Ample account was deleted");
    expect(out).toContain("ample_claim_2");
    expect(api.count("/v1/auth/signup")).toBe(2);
    expect(JSON.parse(readFileSync(file, "utf8")).account.clientId).toBe("agent_2");
  });

  it("retries a failed signup with the same request key, so Ample returns one account", async () => {
    const api = fakeAmple({ signupStatus: 503 });
    const { file, deploy } = setup(api);
    const failed = await deploy.spec.execute({ path: "apps/party" }, ctx);
    expect(failed).toMatchObject({ isError: true });
    expect(text(failed)).toContain("Ample signup failed with HTTP 503");
    const firstKey = JSON.parse(api.calls[0]!.body).request_key;
    expect(JSON.parse(readFileSync(file, "utf8")).pending.requestKey).toBe(firstKey);

    await deploy.spec.execute({ path: "apps/party" }, ctx);
    expect(JSON.parse(api.calls[1]!.body).request_key).toBe(firstKey);
  });

  it("starts a new request key once Ample's receipt for the old one has expired", async () => {
    const api = fakeAmple();
    const { file, deploy } = setup(api);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ pending: { requestKey: "00000000-0000-4000-8000-000000000000", startedAt: "2026-10-01T00:00:00Z" } }));
    await deploy.spec.execute({ path: "apps/party" }, ctx);
    expect(JSON.parse(api.calls[0]!.body).request_key).not.toBe("00000000-0000-4000-8000-000000000000");
  });

  it("makes one account when two deploys start at once", async () => {
    const api = fakeAmple();
    const { deploy } = setup(api);
    await Promise.all([deploy.spec.execute({ path: "apps/party" }, ctx), deploy.spec.execute({ path: "apps/party" }, ctx)]);
    expect(api.count("/v1/auth/signup")).toBe(1);
  });

  it("works without an owner email: no claim email, the link still goes to the agent", async () => {
    const api = fakeAmple();
    const { deploy } = setup(api, undefined, "");
    const out = text(await deploy.spec.execute({ path: "apps/party" }, ctx));
    expect(api.count("/v1/auth/claim")).toBe(0);
    expect(out).toContain("ample_claim_1");
    expect(out).not.toContain("emailed");
  });

  it("reminds the agent of the claim link Ample returns while nobody owns the account", async () => {
    const api = fakeAmple();
    const run = vi.fn<RunCli>(async (args) => {
      const ok: CliResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      if (args[2] === "plan") return { ...ok, stdout: ONE_APP };
      return { ...ok, stdout: JSON.stringify({ status: "live", url: "https://party.apps.ample.computer", claim_url: "https://ample.computer/claim?token=ample_claim_later" }) };
    });
    const { deploy } = setup(api, run);
    await deploy.spec.execute({ path: "apps/party" }, ctx);
    const later = text(await deploy.spec.execute({ path: "apps/party" }, ctx));
    expect(later).toContain("has not claimed this Ample account yet");
    expect(later).toContain("ample_claim_later");
  });
});

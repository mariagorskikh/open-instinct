import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContactStore, Scheduler, StateDir, loadPolicy, type InstinctConfig } from "@open-instinct/core";
import { COMMAND_NAMES, keepsRunning } from "../src/cli.js";
import { fakeFetch, json, readJson, run, tmpDir } from "./helpers.js";

describe("help", () => {
  it("lists every command with an example when run bare", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    for (const name of COMMAND_NAMES) expect(r.out).toContain(name);
    expect(r.out).toContain("instinct init --name");
    expect(r.out).toContain("--data-dir");
  });

  it("prints per-command help for `<cmd> --help`", async () => {
    const r = await run(["trust", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("trust list | set <contact> <tier>");
    expect(r.out).toContain("example");
    const deploy = await run(["deploy", "--help"]);
    expect(deploy.out).toContain("--maritime-llm");
    expect(deploy.out).toContain("LINK_CLIENT_ID");
    const init = await run(["init", "--help"]);
    expect(init.out).toContain("--toolkits");
    const payments = await run(["payments", "--help"]);
    expect(payments.out).toContain("payments connect | status");
  });

  it("rejects unknown commands with exit 2", async () => {
    const r = await run(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('Unknown command "frobnicate"');
  });

  it("prints the version", async () => {
    const r = await run(["--version"]);
    expect(r.out).toMatch(/^instinct \d+\.\d+\.\d+/);
  });
});

describe("init", () => {
  it("writes config.json from flags and reports no Inkbox provisioning without an admin key", async () => {
    const dir = tmpDir();
    const r = await run(
      ["init", "--name", "Maria", "--phone", "+14155550100", "--email", "maria@example.com", "--handle", "maria-instinct", "--model", "anthropic/claude-fable-5-1", "--timezone", "America/New_York"],
      { INSTINCT_DATA_DIR: dir },
    );
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Wrote");
    const config = readJson<InstinctConfig>(dir, "config.json");
    expect(config.owner.name).toBe("Maria");
    expect(config.owner.phones).toContain("+14155550100");
    expect(config.owner.emails).toContain("maria@example.com");
    expect(config.owner.timezone).toBe("America/New_York");
    expect(config.agent.handle).toBe("maria-instinct");
    expect(config.model.primary).toBe("anthropic/claude-fable-5-1");
    expect(r.out).toContain("No INKBOX_ADMIN_API_KEY");
    expect(fs.existsSync(path.join(dir, "secrets", "inkbox.json"))).toBe(false);
  });

  it("updates an existing config instead of discarding it", async () => {
    const dir = tmpDir();
    await run(["init", "--name", "Maria", "--phone", "+14155550100"], { INSTINCT_DATA_DIR: dir });
    const r = await run(["init", "--name", "Maria G", "--email", "m@example.com"], { INSTINCT_DATA_DIR: dir });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Updated");
    const config = readJson<InstinctConfig>(dir, "config.json");
    expect(config.owner.name).toBe("Maria G");
    expect(config.owner.phones).toContain("+14155550100");
    expect(config.owner.emails).toContain("m@example.com");
  });

  it("honours --data-dir over the environment", async () => {
    const envDir = tmpDir();
    const flagDir = path.join(tmpDir(), "nested", "state");
    const r = await run(["init", "--name", "Maria", "--data-dir", flagDir], { INSTINCT_DATA_DIR: envDir });
    expect(r.code, r.err).toBe(0);
    expect(fs.existsSync(path.join(flagDir, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(envDir, "config.json"))).toBe(false);
  });

  it("requires --name", async () => {
    const r = await run(["init"], { INSTINCT_DATA_DIR: tmpDir() });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--name is required");
  });

  it("refuses the reserved handle `owner` and writes nothing", async () => {
    const dir = tmpDir();
    for (const handle of ["owner", "@Owner"]) {
      const r = await run(["init", "--name", "Maria", "--handle", handle, "--skip-inkbox"], { INSTINCT_DATA_DIR: dir });
      expect(r.code).toBe(2);
      expect(r.err).toContain("reserved");
    }
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(false);
    const ok = await run(["init", "--name", "Maria", "--handle", "owner-2", "--skip-inkbox"], { INSTINCT_DATA_DIR: dir });
    expect(ok.code).toBe(0);
  });

  it("turns Composio apps on from --apps, --toolkits or a COMPOSIO_API_KEY in env, also on re-run", async () => {
    const dir = tmpDir();
    await run(["init", "--name", "Maria"], { INSTINCT_DATA_DIR: dir });
    expect(readJson<InstinctConfig>(dir, "config.json").apps.enabled).toBe(false);

    // config.json exists now, so core's env seeding no longer applies; init must do it.
    const viaEnv = await run(["init", "--name", "Maria"], { INSTINCT_DATA_DIR: dir, COMPOSIO_API_KEY: "cmp" });
    expect(viaEnv.code, viaEnv.err).toBe(0);
    expect(viaEnv.out).toContain("apps   on");
    let config = readJson<InstinctConfig>(dir, "config.json");
    expect(config.apps.enabled).toBe(true);
    expect(config.apps.toolkits).toEqual(["gmail", "googlecalendar", "googlecontacts"]);

    await run(["init", "--name", "Maria", "--toolkits", "Gmail, slack"], { INSTINCT_DATA_DIR: dir });
    config = readJson<InstinctConfig>(dir, "config.json");
    expect(config.apps.toolkits).toEqual(["gmail", "slack"]);
    expect(config.apps.enabled).toBe(true);

    await run(["init", "--name", "Maria"], { INSTINCT_DATA_DIR: dir, COMPOSIO_TOOLKITS: "notion" });
    expect(readJson<InstinctConfig>(dir, "config.json").apps.toolkits).toEqual(["notion"]);

    const off = await run(["init", "--name", "Maria", "--no-apps"], { INSTINCT_DATA_DIR: dir, COMPOSIO_API_KEY: "cmp" });
    expect(off.code, off.err).toBe(0);
    config = readJson<InstinctConfig>(dir, "config.json");
    expect(config.apps.enabled).toBe(false);
    expect(config.apps.toolkits).toEqual(["notion"]);

    const fresh = tmpDir();
    await run(["init", "--name", "Maria", "--apps"], { INSTINCT_DATA_DIR: fresh });
    expect(readJson<InstinctConfig>(fresh, "config.json").apps.enabled).toBe(true);
    expect((await run(["init", "--name", "Maria", "--apps", "--no-apps"], { INSTINCT_DATA_DIR: fresh })).code).toBe(2);
  });
});

describe("trust", () => {
  it("set creates the contact when unknown and changes the tier when known", async () => {
    const dir = tmpDir();
    const env = { INSTINCT_DATA_DIR: dir };
    let r = await run(["trust", "set", "Sam Lee", "friend"], env);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Added");
    const contacts = new ContactStore(new StateDir(dir));
    expect(contacts.get("sam-lee")?.tier).toBe("friend");

    r = await run(["trust", "set", "sam-lee", "partner"], env);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Updated");
    expect(new ContactStore(new StateDir(dir)).get("sam-lee")?.tier).toBe("partner");
    expect(new ContactStore(new StateDir(dir)).all()).toHaveLength(1);
  });

  it("rejects an unknown tier and never lets anyone become owner", async () => {
    const env = { INSTINCT_DATA_DIR: tmpDir() };
    expect((await run(["trust", "set", "Sam", "boss"], env)).code).toBe(2);
    expect((await run(["trust", "set", "Sam", "owner"], env)).code).toBe(2);
  });

  it("grant writes a scoped, time-boxed grant to policy.json; list shows it; revoke removes it", async () => {
    const dir = tmpDir();
    const env = { INSTINCT_DATA_DIR: dir };
    await run(["trust", "set", "Sam Lee", "partner"], env);
    const r = await run(
      ["trust", "grant", "sam-lee", "calendar.write,plans.commit", "--until", "2026-12-31", "--max-usd", "150", "--note", "dinner this week"],
      env,
    );
    expect(r.code, r.err).toBe(0);
    const policy = loadPolicy(new StateDir(dir));
    expect(policy.grants).toHaveLength(1);
    const grant = policy.grants[0]!;
    expect(grant.to).toBe("contact:sam-lee");
    expect(grant.capabilities).toEqual(["calendar.write", "plans.commit"]);
    expect(grant.scope?.maxUsd).toBe(150);
    expect(grant.note).toBe("dinner this week");
    expect(grant.expiresAt?.startsWith("2026-12-31T23:59:59")).toBe(true);

    const list = await run(["trust", "list"], env);
    expect(list.out).toContain(grant.id);
    expect(list.out).toContain("sam-lee");
    expect(list.out).toContain("partner");

    const revoke = await run(["trust", "revoke", grant.id], env);
    expect(revoke.code, revoke.err).toBe(0);
    expect(loadPolicy(new StateDir(dir)).grants).toHaveLength(0);
    expect((await run(["trust", "revoke", grant.id], env)).code).toBe(1);
  });

  it("grant refuses unknown capabilities and unknown contacts", async () => {
    const env = { INSTINCT_DATA_DIR: tmpDir() };
    await run(["trust", "set", "Sam", "friend"], env);
    const bad = await run(["trust", "grant", "sam", "launch.rockets"], env);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("Unknown capability");
    const missing = await run(["trust", "grant", "nobody", "calendar.write"], env);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('Unknown contact "nobody"');
  });
});

describe("schedules", () => {
  it("adds a cron job, lists it and removes it", async () => {
    const dir = tmpDir();
    const env = { INSTINCT_DATA_DIR: dir };
    const add = await run(["schedules", "add", "0 8 * * 1-5", "Morning briefing", "--tz", "America/New_York", "--name", "briefing"], env);
    expect(add.code, add.err).toBe(0);
    const entries = new Scheduler(new StateDir(dir)).list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.cron).toBe("0 8 * * 1-5");
    expect(entries[0]!.tz).toBe("America/New_York");
    expect(entries[0]!.prompt).toBe("Morning briefing");
    expect(entries[0]!.enabled).toBe(true);

    const list = await run(["schedules", "list"], env);
    expect(list.out).toContain(entries[0]!.id);
    expect(list.out).toContain("briefing");

    const rm = await run(["schedules", "remove", entries[0]!.id], env);
    expect(rm.code, rm.err).toBe(0);
    expect(new Scheduler(new StateDir(dir)).list()).toHaveLength(0);
  });

  it("adds a one-shot job with --at", async () => {
    const dir = tmpDir();
    const r = await run(["schedules", "add", "--at", "2030-01-01T09:00:00Z", "Remind me about the trip"], { INSTINCT_DATA_DIR: dir });
    expect(r.code, r.err).toBe(0);
    const [entry] = new Scheduler(new StateDir(dir)).list();
    expect(entry?.cron).toBeUndefined();
    expect(entry?.nextRunAt).toBe("2030-01-01T09:00:00.000Z");
  });

  it("rejects malformed cron", async () => {
    const r = await run(["schedules", "add", "0 8 * *", "too few fields"], { INSTINCT_DATA_DIR: tmpDir() });
    expect(r.code).toBe(2);
    expect(r.err).toContain("5 fields");
  });
});

describe("chat", () => {
  it("posts to the local server and prints the reply", async () => {
    const { fetch, calls } = fakeFetch({ "http://127.0.0.1:8080/chat": () => json({ response: "Hi Maria" }) });
    const r = await run(["chat", "hello", "there"], { INSTINCT_DATA_DIR: tmpDir() }, { fetchImpl: fetch });
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toBe("Hi Maria");
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ message: "hello there", source: "cli" });
  });

  it("goes through api.maritime.sh when --agent is given", async () => {
    const { fetch, calls } = fakeFetch({ "https://api.maritime.sh/api/agents/agt_1/chat": () => json({ response: "ok" }) });
    const r = await run(["chat", "ping", "--agent", "agt_1", "--conversation", "c1"], { INSTINCT_DATA_DIR: tmpDir(), MARITIME_API_KEY: "mk_test" }, { fetchImpl: fetch });
    expect(r.code, r.err).toBe(0);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mk_test");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ message: "ping", conversation_id: "c1" });
  });

  it("fails clearly without MARITIME_API_KEY and when the agent returns no response", async () => {
    const noKey = await run(["chat", "ping", "--agent", "agt_1"], { INSTINCT_DATA_DIR: tmpDir() });
    expect(noKey.code).toBe(1);
    expect(noKey.err).toContain("MARITIME_API_KEY");
    const { fetch } = fakeFetch({ "http://127.0.0.1:8080/chat": () => json({ response: null, error: "asleep" }) });
    const r = await run(["chat", "ping"], { INSTINCT_DATA_DIR: tmpDir() }, { fetchImpl: fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain("asleep");
  });

  it("sends INSTINCT_CHAT_TOKEN as a Bearer header on chat and status, and explains a 401", async () => {
    const { fetch, calls } = fakeFetch({
      "http://127.0.0.1:8080/chat": () => json({ response: "ok" }),
      "http://127.0.0.1:8080/": () => json({ ok: true }),
    });
    const env = { INSTINCT_DATA_DIR: tmpDir(), INSTINCT_CHAT_TOKEN: "tok_1" };
    expect((await run(["chat", "ping"], env, { fetchImpl: fetch })).code).toBe(0);
    expect((await run(["status"], env, { fetchImpl: fetch })).code).toBe(0);
    for (const c of calls) expect((c.init.headers as Record<string, string>).Authorization).toBe("Bearer tok_1");

    const locked = fakeFetch({ "http://127.0.0.1:8080/chat": () => json({ error: "missing or invalid token" }, 401), "http://127.0.0.1:8080/": () => json({}, 401) });
    const chat = await run(["chat", "ping"], { INSTINCT_DATA_DIR: tmpDir() }, { fetchImpl: locked.fetch });
    expect(chat.code).toBe(1);
    expect(chat.err).toContain("INSTINCT_CHAT_TOKEN");
    const status = await run(["status"], { INSTINCT_DATA_DIR: tmpDir() }, { fetchImpl: locked.fetch });
    expect(status.code).toBe(1);
    expect(status.err).toContain("INSTINCT_CHAT_TOKEN");
  });
});

describe("status", () => {
  it("prints a flattened table of GET /", async () => {
    const { fetch } = fakeFetch({ "http://localhost:9999/": () => json({ name: "Maria's Instinct", owner: { name: "Maria" }, conversations: 3 }) });
    const r = await run(["status", "--url", "http://localhost:9999"], { INSTINCT_DATA_DIR: tmpDir() }, { fetchImpl: fetch });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("owner.name");
    expect(r.out).toContain("Maria");
    expect(r.out).toMatch(/conversations\s+3/);
  });
});

describe("deploy", () => {
  async function seeded(): Promise<string> {
    const dir = tmpDir();
    await run(["init", "--name", "Maria", "--phone", "+14155550100", "--email", "maria@example.com", "--handle", "maria-instinct"], { INSTINCT_DATA_DIR: dir });
    fs.mkdirSync(path.join(dir, "secrets"));
    fs.writeFileSync(path.join(dir, "secrets", "inkbox.json"), JSON.stringify({ handle: "maria-instinct", identityId: "idn_1", apiKey: "ik_secret", signingKey: "whsec_x" }));
    return dir;
  }

  it("--dry-run prints the create body with secrets redacted", async () => {
    const dir = await seeded();
    const r = await run(["deploy", "--image", "ghcr.io/maria/open-instinct-agent:v1", "--dry-run"], {
      INSTINCT_DATA_DIR: dir,
      ANTHROPIC_API_KEY: "sk-ant-x",
      CONTEXT_DEV_API_KEY: "ctxt_secret_test",
      AMPLE_CLIENT_ID: "agent_test",
      AMPLE_CLIENT_SECRET: "ample_agent_secret_test",
    });
    expect(r.code, r.err).toBe(0);
    const body = JSON.parse(r.out);
    expect(body.name).toBe("instinct-maria-instinct");
    expect(body.framework).toBe("custom");
    expect(body.desktop).toBe(true);
    // Maritime injects PORT=18789 for framework "custom"; the exposed port must be the same number.
    expect(body.exposedPort).toBe(18789);
    expect(body.useMaritimeLlm).toBeUndefined();
    expect(body.healthCheckPath).toBe("/health");
    expect(body.externalId).toBe("open-instinct:maria-instinct");
    expect(body.idleTtlSeconds).toBe(900);
    const vars = Object.fromEntries(body.initialEnvVars.map((v: { key: string; value: string; isSecret: boolean }) => [v.key, v]));
    expect(vars.PORT).toEqual({ key: "PORT", value: String(body.exposedPort), isSecret: false });
    expect(vars.INKBOX_API_KEY).toEqual({ key: "INKBOX_API_KEY", value: "<redacted>", isSecret: true });
    expect(vars.ANTHROPIC_API_KEY.value).toBe("<redacted>");
    expect(vars.CONTEXT_DEV_API_KEY.value).toBe("<redacted>");
    expect(vars.AMPLE_CLIENT_ID).toEqual({ key: "AMPLE_CLIENT_ID", value: "agent_test", isSecret: false });
    expect(vars.AMPLE_CLIENT_SECRET.value).toBe("<redacted>");
    expect(vars.AMPLE_TOKEN).toBeUndefined();
    expect(vars.INSTINCT_OWNER_PHONE).toEqual({ key: "INSTINCT_OWNER_PHONE", value: "+14155550100", isSecret: false });
    expect(vars.INSTINCT_DATA_DIR.value).toBe("/data");
    expect(vars.INSTINCT_MODEL.value).toBe("anthropic/claude-fable-5-1");
    expect(vars.LINK_CLIENT_ID).toBeUndefined();
    expect(r.out).not.toContain("ik_secret");
    expect(r.out).not.toContain("ample_agent_secret_test");
  });

  it("keeps the Inkbox endpoint with the deployed identity credentials", async () => {
    const dir = await seeded();
    const result = await run(["deploy", "--image", "img:1", "--dry-run"], {
      INSTINCT_DATA_DIR: dir, ANTHROPIC_API_KEY: "model_test", INKBOX_BASE_URL: "https://inkbox.example",
    });
    expect(result.code, result.err).toBe(0);
    const body = JSON.parse(result.out);
    expect(body.initialEnvVars).toContainEqual({ key: "INKBOX_BASE_URL", value: "https://inkbox.example", isSecret: false });
  });

  it("--maritime-llm asks Maritime for its metered model and points INSTINCT_MODEL at it", async () => {
    const dir = await seeded();
    const r = await run(["deploy", "--image", "img:1", "--maritime-llm", "--dry-run"], { INSTINCT_DATA_DIR: dir, OPENAI_API_KEY: "sk-mine", OPENAI_BASE_URL: "http://mine" });
    expect(r.code, r.err).toBe(0);
    expect(r.err).not.toContain("no model");
    const body = JSON.parse(r.out);
    expect(body.useMaritimeLlm).toBe(true);
    const vars = Object.fromEntries(body.initialEnvVars.map((v: { key: string; value: string }) => [v.key, v.value]));
    expect(vars.INSTINCT_MODEL).toBe("openai-compatible/gpt-5.4");
    // Our own OPENAI_* would shadow the injected proxy credentials, so they stay home.
    expect(vars.OPENAI_API_KEY).toBeUndefined();
    expect(vars.OPENAI_BASE_URL).toBeUndefined();

    const picked = await run(["deploy", "--image", "img:1", "--maritime-llm", "--model", "gpt-5.5", "--dry-run"], { INSTINCT_DATA_DIR: dir, INSTINCT_MARITIME_MODEL: "gpt-5" });
    expect(JSON.parse(picked.out).initialEnvVars.find((v: { key: string }) => v.key === "INSTINCT_MODEL").value).toBe("openai-compatible/gpt-5.5");
    const fromEnv = await run(["deploy", "--image", "img:1", "--maritime-llm", "--dry-run"], { INSTINCT_DATA_DIR: dir, INSTINCT_MARITIME_MODEL: "gpt-5" });
    expect(JSON.parse(fromEnv.out).initialEnvVars.find((v: { key: string }) => v.key === "INSTINCT_MODEL").value).toBe("openai-compatible/gpt-5");

    // Without the flag and without any key, the warning names the flag.
    const none = await run(["deploy", "--image", "img:1", "--dry-run"], { INSTINCT_DATA_DIR: dir });
    expect(none.err).toContain("--maritime-llm");
    expect(JSON.parse(none.out).useMaritimeLlm).toBeUndefined();
  });

  it("passes LINK_* and STRIPE_PUBLISHABLE_KEY into the agent when LINK_CLIENT_ID is set", async () => {
    const dir = await seeded();
    const r = await run(["deploy", "--image", "img:1", "--dry-run"], {
      INSTINCT_DATA_DIR: dir,
      ANTHROPIC_API_KEY: "sk",
      LINK_CLIENT_ID: "lc_1",
      LINK_CLIENT_SECRET: "ls_1",
      LINK_REDIRECT_URI: "https://gw.example.com/oauth/link/callback/usr_1",
      STRIPE_PUBLISHABLE_KEY: "pk_test_1",
    });
    expect(r.code, r.err).toBe(0);
    const vars = Object.fromEntries(JSON.parse(r.out).initialEnvVars.map((v: { key: string; value: string; isSecret: boolean }) => [v.key, v]));
    expect(vars.LINK_CLIENT_ID).toEqual({ key: "LINK_CLIENT_ID", value: "lc_1", isSecret: false });
    expect(vars.LINK_CLIENT_SECRET).toEqual({ key: "LINK_CLIENT_SECRET", value: "<redacted>", isSecret: true });
    expect(vars.LINK_REDIRECT_URI.value).toBe("https://gw.example.com/oauth/link/callback/usr_1");
    expect(vars.STRIPE_PUBLISHABLE_KEY).toEqual({ key: "STRIPE_PUBLISHABLE_KEY", value: "pk_test_1", isSecret: false });
    expect(r.err).not.toContain("LINK_REDIRECT_URI");

    const noRedirect = await run(["deploy", "--image", "img:1", "--dry-run"], { INSTINCT_DATA_DIR: dir, ANTHROPIC_API_KEY: "sk", LINK_CLIENT_ID: "lc_1" });
    expect(noRedirect.err).toContain("LINK_REDIRECT_URI");
    // A secret without a client id is not copied: it would be useless and leak for nothing.
    const orphan = await run(["deploy", "--image", "img:1", "--dry-run"], { INSTINCT_DATA_DIR: dir, ANTHROPIC_API_KEY: "sk", LINK_CLIENT_SECRET: "ls_1" });
    expect(JSON.parse(orphan.out).initialEnvVars.some((v: { key: string }) => v.key.startsWith("LINK_"))).toBe(false);
  });

  it("creates the agent through POST /api/agents and records the id", async () => {
    const dir = await seeded();
    const { fetch, calls } = fakeFetch({ "https://api.maritime.sh/api/agents": () => json({ id: "agt_42", name: "instinct-maria-instinct", status: "deploying" }) });
    const r = await run(
      ["deploy", "--image", "ghcr.io/maria/open-instinct-agent:v1", "--idle", "600", "--name", "my-instinct"],
      { INSTINCT_DATA_DIR: dir, MARITIME_API_KEY: "mk_live", ANTHROPIC_API_KEY: "sk-ant-x" },
      { fetchImpl: fetch },
    );
    expect(r.code, r.err).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer mk_live");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.name).toBe("my-instinct");
    expect(body.idleTtlSeconds).toBe(600);
    expect(body.initialEnvVars.find((v: { key: string }) => v.key === "INKBOX_API_KEY").value).toBe("ik_secret");
    expect(r.out).toContain("agt_42");
    expect(r.out).toContain("https://maritime.sh/dashboard/agents/agt_42");
    expect(r.out).toContain("gateway");
    expect(r.out).toContain("--tunnel");
    expect(readJson<{ agentId: string }>(dir, "maritime.json").agentId).toBe("agt_42");
  });

  it("surfaces a 402 with the server's detail", async () => {
    const dir = await seeded();
    const { fetch } = fakeFetch({ "https://api.maritime.sh/api/agents": () => json({ detail: "Plan allows 3 agents. Upgrade at https://maritime.sh/billing" }, 402) });
    const r = await run(["deploy", "--image", "img:1"], { INSTINCT_DATA_DIR: dir, MARITIME_API_KEY: "mk_live" }, { fetchImpl: fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain("402");
    expect(r.err).toContain("maritime.sh/billing");
  });

  it("needs --image and MARITIME_API_KEY", async () => {
    const dir = await seeded();
    expect((await run(["deploy"], { INSTINCT_DATA_DIR: dir })).err).toContain("--image is required");
    const r = await run(["deploy", "--image", "img:1"], { INSTINCT_DATA_DIR: dir });
    expect(r.code).toBe(1);
    expect(r.err).toContain("MARITIME_API_KEY");
  });
});

describe("dev", () => {
  function fakeServer() {
    const seen: { bootEnv?: NodeJS.ProcessEnv; httpOpts?: Record<string, unknown>; listened?: [number, string]; closed: boolean; webhook?: Record<string, unknown> } = { closed: false };
    const mod = {
      boot: async (e: NodeJS.ProcessEnv) => {
        seen.bootEnv = e;
        return { state: { root: "fake" }, close: async () => undefined };
      },
      createHttpServer: (_app: unknown, opts?: Record<string, unknown>) => {
        seen.httpOpts = opts;
        return {
          listen: (port: number, host: string, cb?: () => void) => {
            seen.listened = [port, host];
            cb?.();
          },
          once: () => undefined,
          close: (cb?: () => void) => {
            seen.closed = true;
            cb?.();
          },
        };
      },
      ensureWebhookSubscription: async (opts: Record<string, unknown>) => {
        seen.webhook = opts;
        return { subscriptionId: "sub_1", created: true };
      },
      readWebhookSecrets: () => ({ signingKey: "from-webhook-file" }),
      listenTunnelServer: async () => ({ listen: () => {}, address: () => ({ port: 9124 }), close: (cb?: () => void) => cb?.() }),
    };
    return { mod, seen };
  }

  it("loads secrets into env, sets PORT, boots and listens", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "secrets"));
    fs.writeFileSync(path.join(dir, "secrets", "inkbox.json"), JSON.stringify({ handle: "h", identityId: "i", apiKey: "k", signingKey: "s" }));
    const { mod, seen } = fakeServer();
    const env: NodeJS.ProcessEnv = { INSTINCT_DATA_DIR: dir, INKBOX_API_KEY: "already-set" };
    const r = await run(["dev", "--port", "9123"], env, { importServer: async () => mod, installSignalHandlers: false });
    expect(r.code, r.err).toBe(0);
    expect(seen.listened).toEqual([9123, "127.0.0.1"]);
    expect(seen.bootEnv?.PORT).toBe("9123");
    expect(seen.bootEnv?.INSTINCT_TUNNEL).toBeUndefined();
    expect(seen.bootEnv?.INSTINCT_DATA_DIR).toBe(dir);
    expect(seen.bootEnv?.INKBOX_AGENT_HANDLE).toBe("h");
    expect(seen.bootEnv?.INKBOX_SIGNING_KEY).toBe("s");
    // Existing env wins over the secrets file.
    expect(seen.bootEnv?.INKBOX_API_KEY).toBe("already-set");
    expect(seen.httpOpts?.env).toBe(env);
    expect((seen.httpOpts?.signingKeyProvider as () => string)()).toBe("s");
    expect(r.out).toContain("running");
    expect(r.out).toContain("no tunnel");
  });

  it("--tunnel opens the Inkbox tunnel and subscribes the webhook at <publicUrl>/webhooks/inkbox", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "secrets"));
    fs.writeFileSync(path.join(dir, "secrets", "inkbox.json"), JSON.stringify({ handle: "maria-instinct", identityId: "idn_1", apiKey: "ik" }));
    const { mod, seen } = fakeServer();
    const tunnels: unknown[] = [];
    const r = await run(["dev", "--tunnel"], { INSTINCT_DATA_DIR: dir, INKBOX_ADMIN_API_KEY: "ak" }, {
      importServer: async () => mod,
      installSignalHandlers: false,
      connectTunnel: async (opts) => {
        tunnels.push(opts);
        return { publicUrl: "https://maria-instinct.inkboxwire.com", close: async () => undefined };
      },
    });
    expect(r.code, r.err).toBe(0);
    expect(seen.bootEnv?.INSTINCT_TUNNEL).toBe("1");
    expect(tunnels[0]).toMatchObject({ apiKey: "ik", handle: "maria-instinct", forwardTo: "http://127.0.0.1:9124" });
    expect(seen.webhook).toMatchObject({ adminApiKey: "ak", handle: "maria-instinct", identityId: "idn_1", url: "https://maria-instinct.inkboxwire.com/webhooks/inkbox" });
    expect(r.out).toContain("sub_1");
    // Without a signing key in env, the provider falls back to the server's webhook file.
    expect((seen.httpOpts?.signingKeyProvider as () => string)()).toBe("from-webhook-file");
  });

  it("--tunnel without Inkbox credentials warns and keeps the server up", async () => {
    const { mod, seen } = fakeServer();
    const r = await run(["dev", "--tunnel"], { INSTINCT_DATA_DIR: tmpDir() }, { importServer: async () => mod, installSignalHandlers: false });
    expect(r.code, r.err).toBe(0);
    expect(seen.listened).toBeDefined();
    expect(r.err).toContain("tunnel not started");
  });

  it("warns when COMPOSIO_API_KEY is set but config.json has apps off, and names the fix", async () => {
    const dir = tmpDir();
    await run(["init", "--name", "Maria"], { INSTINCT_DATA_DIR: dir });
    const { mod } = fakeServer();
    const r = await run(["dev"], { INSTINCT_DATA_DIR: dir, COMPOSIO_API_KEY: "cmp" }, { importServer: async () => mod, installSignalHandlers: false });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("apps.enabled=false");
    expect(r.err).toContain("--apps");

    await run(["init", "--name", "Maria", "--apps"], { INSTINCT_DATA_DIR: dir });
    const quiet = await run(["dev"], { INSTINCT_DATA_DIR: dir, COMPOSIO_API_KEY: "cmp" }, { importServer: async () => mod, installSignalHandlers: false });
    expect(quiet.err).not.toContain("apps.enabled");
    const noKey = await run(["dev"], { INSTINCT_DATA_DIR: tmpDir() }, { importServer: async () => mod, installSignalHandlers: false });
    expect(noKey.err).not.toContain("apps.enabled");
  });

  it("is the only command the binary keeps alive, wherever --data-dir sits", async () => {
    expect(keepsRunning(["dev"])).toBe(true);
    expect(keepsRunning(["--data-dir", "./x", "dev", "--tunnel"])).toBe(true);
    expect(keepsRunning(["--data-dir=./x", "dev"])).toBe(true);
    expect(keepsRunning(["dev", "--data-dir", "./x"])).toBe(true);
    expect(keepsRunning(["--data-dir", "dev"])).toBe(false);
    expect(keepsRunning(["chat", "dev"])).toBe(false);
    expect(keepsRunning(["--data-dir"])).toBe(false);
    expect(keepsRunning([])).toBe(false);
  });
});

describe("payments", () => {
  it("connect prints the authorize URL the running server offers", async () => {
    const { fetch, calls } = fakeFetch({
      "http://127.0.0.1:8080/oauth/link/start": () => json({ url: "https://login.link.com/auth?client_id=lc_1&state=srv" }),
    });
    const r = await run(["payments", "connect"], { INSTINCT_DATA_DIR: tmpDir() }, { fetchImpl: fetch });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("https://login.link.com/auth?client_id=lc_1&state=srv");
    expect(r.err).toBe("");
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/oauth/link/start");

    const redirecting = fakeFetch({
      "http://localhost:9000/oauth/link/start": () => new Response(null, { status: 302, headers: { Location: "https://login.link.com/auth?x=1" } }),
    });
    const r2 = await run(["payments", "connect", "--url", "http://localhost:9000"], { INSTINCT_DATA_DIR: tmpDir() }, { fetchImpl: redirecting.fetch });
    expect(r2.code, r2.err).toBe(0);
    expect(r2.out).toContain("https://login.link.com/auth?x=1");
  });

  it("connect falls back to LINK_CLIENT_ID when the server has no Link route, and fails clearly without either", async () => {
    const { fetch } = fakeFetch({ "http://127.0.0.1:8080/oauth/link/start": () => json({ error: "not found" }, 404) });
    const r = await run(["payments", "connect"], { INSTINCT_DATA_DIR: tmpDir(), LINK_CLIENT_ID: "lc_1", LINK_REDIRECT_URI: "https://gw.example.com/oauth/link/callback/usr_1" }, { fetchImpl: fetch });
    expect(r.code, r.err).toBe(0);
    const url = new URL(r.out.trim());
    expect(url.origin + url.pathname).toBe("https://login.link.com/auth");
    expect(url.searchParams.get("client_id")).toBe("lc_1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://gw.example.com/oauth/link/callback/usr_1");
    expect(url.searchParams.get("scope")).toBe("payment_methods.agentic");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{24}$/);
    expect(r.err).toContain("built from LINK_CLIENT_ID");

    const none = await run(["payments", "connect"], { INSTINCT_DATA_DIR: tmpDir() }, { fetchImpl: fetch });
    expect(none.code).toBe(1);
    expect(none.err).toContain("LINK_CLIENT_ID");

    const down = fakeFetch({});
    down.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const unreachable = await run(["payments", "connect"], { INSTINCT_DATA_DIR: tmpDir(), LINK_CLIENT_ID: "lc" }, { fetchImpl: down.fetch });
    expect(unreachable.code).toBe(1);
    expect(unreachable.err).toContain("instinct dev");
  });

  it("status prints the server's payments report and the local LINK_* configuration", async () => {
    const { fetch } = fakeFetch({ "http://127.0.0.1:8080/payments/status": () => json({ connected: true, wallet: "link", expiresAt: "2026-10-04T00:00:00Z" }) });
    const r = await run(["payments", "status"], { INSTINCT_DATA_DIR: tmpDir(), LINK_CLIENT_ID: "lc_1" }, { fetchImpl: fetch });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/connected\s+true/);
    expect(r.out).toMatch(/wallet\s+link/);
    expect(r.out).toMatch(/LINK_CLIENT_ID\s+set/);
    expect(r.out).toMatch(/LINK_CLIENT_SECRET\s+missing/);
    expect(r.out).not.toContain("lc_1");

    const old = fakeFetch({
      "http://127.0.0.1:8080/payments/status": () => json({ error: "not found" }, 404),
      "http://127.0.0.1:8080/": () => json({ ok: true, payments: { connected: false } }),
    });
    const r2 = await run(["payments", "status"], { INSTINCT_DATA_DIR: tmpDir() }, { fetchImpl: old.fetch });
    expect(r2.code, r2.err).toBe(0);
    expect(r2.out).toMatch(/connected\s+false/);

    const bare = fakeFetch({
      "http://127.0.0.1:8080/payments/status": () => json({ error: "not found" }, 404),
      "http://127.0.0.1:8080/": () => json({ ok: true }),
    });
    const r3 = await run(["payments", "status"], { INSTINCT_DATA_DIR: tmpDir() }, { fetchImpl: bare.fetch });
    expect(r3.code, r3.err).toBe(0);
    expect(r3.out).toContain("does not report payments");
  });

  it("needs a subcommand", async () => {
    const r = await run(["payments"], { INSTINCT_DATA_DIR: tmpDir() });
    expect(r.code).toBe(2);
    expect(r.err).toContain("connect | status");
    expect((await run(["payments", "refund"], { INSTINCT_DATA_DIR: tmpDir() })).code).toBe(2);
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_IMAGE, checkSignupPolicy, readEnv } from "../src/main.js";

describe("readEnv", () => {
  it("requires MARITIME_API_KEY and reads the signup, Composio, Maritime LLM and Link settings", () => {
    expect(() => readEnv({})).toThrow(/MARITIME_API_KEY/);
    const cfg = readEnv({
      MARITIME_API_KEY: "mk",
      INKBOX_ADMIN_API_KEY: "ak",
      GATEWAY_ALLOW_OPEN_SIGNUP: "1",
      GATEWAY_TRUST_PROXY: "true",
      COMPOSIO_API_KEY: "cmp",
      COMPOSIO_TOOLKITS: "gmail,slack",
      CONTEXT_DEV_API_KEY: "ctxt_secret_test",
      INSTINCT_USE_MARITIME_LLM: "1",
      INSTINCT_MARITIME_MODEL: "gpt-5.5",
      LINK_CLIENT_ID: "lc_1",
      LINK_CLIENT_SECRET: "ls_1",
      STRIPE_PUBLISHABLE_KEY: "pk_test_1",
    });
    expect(cfg.agentImage).toBe(DEFAULT_AGENT_IMAGE);
    expect(cfg.allowOpenSignup).toBe(true);
    expect(cfg.trustProxy).toBe(true);
    expect(cfg.composioToolkits).toBe("gmail,slack");
    expect(cfg.contextDevApiKey).toBe("ctxt_secret_test");
    expect(cfg.useMaritimeLlm).toBe(true);
    expect(cfg.maritimeModel).toBe("gpt-5.5");
    expect(cfg.link).toEqual({ clientId: "lc_1", clientSecret: "ls_1", stripePublishableKey: "pk_test_1" });

    const plain = readEnv({ MARITIME_API_KEY: "mk", LINK_CLIENT_SECRET: "orphan" });
    expect(plain.allowOpenSignup).toBe(false);
    expect(plain.useMaritimeLlm).toBe(false);
    expect(plain.link).toBeUndefined();
  });
});

describe("checkSignupPolicy", () => {
  it("refuses to start an open, billed signup form unless the operator opts in by name", () => {
    expect(checkSignupPolicy({ inkboxAdminApiKey: "ak", signupSecret: undefined, allowOpenSignup: false })).toMatchObject({ ok: false, reason: expect.stringContaining("GATEWAY_SIGNUP_SECRET") });
    expect(checkSignupPolicy({ inkboxAdminApiKey: "ak", signupSecret: "code", allowOpenSignup: false })).toEqual({ ok: true, open: false });
    expect(checkSignupPolicy({ inkboxAdminApiKey: "ak", signupSecret: undefined, allowOpenSignup: true })).toEqual({ ok: true, open: true });
    // Relay-only gateways have no form to protect.
    expect(checkSignupPolicy({ inkboxAdminApiKey: undefined, signupSecret: undefined, allowOpenSignup: false })).toEqual({ ok: true, open: false });
  });
});

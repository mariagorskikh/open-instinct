import { describe, expect, it } from "vitest";
import { normalizeHandle, normalizePhone, parseBrainUpdate, secretMatches, validateSignup } from "../src/validate.js";

describe("validateSignup", () => {
  it("normalizes and accepts a good signup", () => {
    const r = validateSignup({ name: " Maria ", phone: "(415) 555-0123", email: "Maria@Example.com", handle: "@Maria-1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ name: "Maria", phone: "+14155550123", email: "maria@example.com", handle: "maria-1", templateId: "default" });
  });

  it("accepts a known template id and rejects unknown or malformed ones", () => {
    const known = ["default", "gtm-ai"];
    const ok = validateSignup({ name: "S", phone: "+14155550123", handle: "sam", templateId: "gtm-ai" }, { knownTemplates: known });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.templateId).toBe("gtm-ai");

    const unknown = validateSignup({ name: "S", phone: "+14155550123", handle: "sam", templateId: "nope" }, { knownTemplates: known });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors["templateId"]).toMatch(/not available/);

    const traversal = validateSignup({ name: "S", phone: "+14155550123", handle: "sam", template_id: "../etc/passwd" }, { knownTemplates: known });
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.errors["templateId"]).toMatch(/short lowercase/);
  });

  it("rejects bad phones, handles and emails with field errors", () => {
    const r = validateSignup({ name: "", phone: "12345", email: "nope", handle: "a b" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["email", "handle", "name", "phone"]);
  });

  it("requires E.164 and the handle charset", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("1 415 555 0123")).toBe("+14155550123");
    expect(normalizePhone("")).toBe("");
    expect(normalizeHandle("  @@Sam_Lee ")).toBe("sam_lee");
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "sam_lee" }).ok).toBe(false);
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "ab" }).ok).toBe(false);
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "a".repeat(41) }).ok).toBe(false);
    expect(validateSignup({ name: "S", phone: "+04155550123", handle: "sam" }).ok).toBe(false);
  });

  it("refuses the reserved handle `owner` in any spelling", () => {
    for (const handle of ["owner", "@owner", " Owner "]) {
      const r = validateSignup({ name: "S", phone: "+14155550123", handle });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors["handle"]).toMatch(/reserved/);
    }
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "owner-2" }).ok).toBe(true);
  });

  it("checks the invite code only when configured", () => {
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "sam" }, { signupSecret: "letmein" }).ok).toBe(false);
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "sam", inviteCode: "letmein" }, { signupSecret: "letmein" }).ok).toBe(true);
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "sam", invite_code: "letmein" }, { signupSecret: "letmein" }).ok).toBe(true);
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "sam", inviteCode: "wrong" }).ok).toBe(true);
    expect(secretMatches("abc", "abcd")).toBe(false);
    expect(secretMatches(undefined, undefined)).toBe(true);
  });

  it("treats non-string fields as empty", () => {
    const r = validateSignup({ name: 42, phone: null, handle: ["x"] });
    expect(r.ok).toBe(false);
  });
});

describe("signup brain fields", () => {
  it("normalizes a repo URL and trims the token", () => {
    const r = validateSignup({
      name: "S",
      phone: "+14155550123",
      handle: "sam",
      brainRepo: " https://github.com/acme/handbook/tree/main/docs ",
      brainToken: " ghp_abcdefgh123456 ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ brainRepo: "acme/handbook", brainToken: "ghp_abcdefgh123456" });
  });

  it("reports brain problems as field errors", () => {
    const badRepo = validateSignup({ name: "S", phone: "+14155550123", handle: "sam", brainRepo: "just-a-name" });
    expect(badRepo.ok).toBe(false);
    if (!badRepo.ok) expect(badRepo.errors["brainRepo"]).toMatch(/owner\/repo/);

    const badToken = validateSignup({ name: "S", phone: "+14155550123", handle: "sam", brainRepo: "acme/handbook", brainToken: "short" });
    expect(badToken.ok).toBe(false);
    if (!badToken.ok) expect(badToken.errors["brainToken"]).toBeDefined();
  });

  it("leaves the brain off when the fields are blank", () => {
    const r = validateSignup({ name: "S", phone: "+14155550123", handle: "sam", brainRepo: "", brainToken: "" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.brainRepo).toBeUndefined();
      expect(r.value.brainToken).toBeUndefined();
    }
  });
});

describe("parseBrainUpdate", () => {
  it("reads an empty repo as a clear", () => {
    expect(parseBrainUpdate({ brainRepo: "" })).toEqual({ ok: true, value: { repo: "" } });
    expect(parseBrainUpdate({})).toEqual({ ok: true, value: { repo: "" } });
  });

  it("keeps the saved token when the token box is left empty", () => {
    const r = parseBrainUpdate({ brainRepo: "acme/notes" });
    expect(r).toEqual({ ok: true, value: { repo: "acme/notes" } });
  });

  it("takes a new token alongside the repo", () => {
    const r = parseBrainUpdate({ brain_repo: "acme/notes", brain_token: "ghp_abcdefgh123456" });
    expect(r).toEqual({ ok: true, value: { repo: "acme/notes", token: "ghp_abcdefgh123456" } });
  });

  it("rejects a broken repo or token", () => {
    const repo = parseBrainUpdate({ brainRepo: "not-a-repo" });
    expect(repo.ok).toBe(false);
    if (!repo.ok) expect(repo.errors["brainRepo"]).toBeDefined();

    const token = parseBrainUpdate({ brainRepo: "acme/notes", brainToken: "no" });
    expect(token.ok).toBe(false);
    if (!token.ok) expect(token.errors["brainToken"]).toBeDefined();
  });
});

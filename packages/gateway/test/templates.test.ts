import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEMPLATE_ID, TemplateError, defaultTemplateDir, loadTemplateRegistry } from "../src/templates.js";

const shipped = loadTemplateRegistry();

describe("shipped template registry", () => {
  it("lists exactly the shipped ids with default present", () => {
    expect(shipped.ids()).toEqual(["default", "gtm-ai"]);
    expect(shipped.get(undefined)?.id).toBe(DEFAULT_TEMPLATE_ID);
    expect(shipped.resolve(undefined).id).toBe("default");
    expect(shipped.resolve("gtm-ai").id).toBe("gtm-ai");
  });

  it("default carries no persona or skills and a light desktop-less footprint", () => {
    const t = shipped.resolve("default");
    expect(t.persona).toBeUndefined();
    expect(t.instructions).toBeUndefined();
    expect(t.skills).toEqual([]);
    expect(t.hardware).toEqual({ cpu: 1, ramGb: 4, desktop: false });
    expect(t.env).toEqual({});
  });

  it("gtm-ai carries the persona, house rules, skills and model", () => {
    const t = shipped.resolve("gtm-ai");
    expect(t.title).toBe("AI-native GTM");
    expect(t.persona).toContain("# Role — AI-native GTM Operator");
    expect(t.instructions).toContain("explicit approval");
    expect(t.skills.map((s) => s.name)).toEqual(["gtm-playbook"]);
    expect(t.skills[0]?.content).toContain("Pain-Qualified");
    expect(t.model).toEqual({ provider: "openai-compatible", default: "gpt-5.4" });
    expect(t.env["COMPOSIO_TOOLKITS"]).toBe("gmail,googlecalendar,custom_executor");
    expect(t.env["COMPOSIO_MODE"]).toBe("router");
    expect(t.hardware).toEqual({ cpu: 2, ramGb: 4, desktop: false });
  });

  it("resolve throws on an unknown template id", () => {
    expect(() => shipped.resolve("web3-rd")).toThrow(TemplateError);
    expect(() => shipped.resolve("../registry/default")).toThrow(TemplateError);
  });

  it("defaultTemplateDir points at the shipped registry", () => {
    expect(shipped.dir).toBe(defaultTemplateDir());
  });
});

describe("loadTemplateRegistry validation", () => {
  function writeRegistry(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "templates-test-"));
    mkdirSync(join(dir, "registry"), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "registry", name), body);
    return dir;
  }

  const base = (over: string) => `
api_version: instinct/v1
template:
  name: default
  title: T
  version: 1.0.0
  description: d
skills: []
env: {}
${over}
`;

  it("requires the default template to exist", () => {
    expect(() => loadTemplateRegistry(writeRegistry({ "other.yaml": base("") }))).toThrow(/missing default/);
  });

  it("rejects a name that does not match the file, bad semver, and path-traversal persona", () => {
    expect(() =>
      loadTemplateRegistry(
        writeRegistry({
          "default.yaml": base(""),
          "demo.yaml": base("").replace("name: default", "name: not-demo"),
        }),
      ),
    ).toThrow(/name must equal the file name/);
    expect(() => loadTemplateRegistry(writeRegistry({ "default.yaml": base("").replace("1.0.0", "v1") }))).toThrow(/semver/);
    expect(() =>
      loadTemplateRegistry(writeRegistry({ "default.yaml": base("").replace("description: d", "description: d\n  persona: ../../etc/passwd") })),
    ).toThrow(/persona file not found/);
  });

  it("rejects unknown skills and non-scalar env values", () => {
    expect(() =>
      loadTemplateRegistry(writeRegistry({ "default.yaml": base("skills:\n  - missing-skill").replace("skills: []\n", "") })),
    ).toThrow(/has no SKILL.md/);
    expect(() =>
      loadTemplateRegistry(writeRegistry({ "default.yaml": base("env:\n  THING:\n    nested: 1").replace("env: {}\n", "") })),
    ).toThrow(/must be a scalar/);
  });

  it("loads a valid custom template with its skill content", () => {
    const dir = writeRegistry({ "default.yaml": base("") });
    mkdirSync(join(dir, "skills", "hello"), { recursive: true });
    writeFileSync(join(dir, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: h\n---\nHello");
    writeFileSync(
      join(dir, "registry", "demo.yaml"),
      base("").replace("name: default", "name: demo").replace("skills: []", "skills:\n  - hello"),
    );
    const reg = loadTemplateRegistry(dir);
    expect(reg.ids()).toEqual(["default", "demo"]);
    expect(reg.resolve("demo").skills[0]).toEqual({ name: "hello", content: "---\nname: hello\ndescription: h\n---\nHello" });
  });

  it("copies a shipped persona through a temp dir with matching content", () => {
    const dir = writeRegistry({ "default.yaml": base("") });
    mkdirSync(join(dir, "personas"), { recursive: true });
    copyFileSync(join(defaultTemplateDir(), "personas", "gtm-ai.md"), join(dir, "personas", "gtm-ai.md"));
    writeFileSync(
      join(dir, "registry", "with-persona.yaml"),
      base("").replace("name: default", "name: with-persona").replace("description: d", "description: d\n  persona: gtm-ai"),
    );
    const reg = loadTemplateRegistry(dir);
    expect(reg.resolve("with-persona").persona).toContain("AI-native GTM Operator");
  });
});

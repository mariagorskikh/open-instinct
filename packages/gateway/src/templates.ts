import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/** Matches hermes' template id contract: lowercase letters, digits and dashes, path-traversal safe. */
export const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DEFAULT_TEMPLATE_ID = "default";
export const TEMPLATE_API_VERSION = "instinct/v1";

export interface TemplateSkill {
  name: string;
  content: string;
}

/** A deployable agent template: persona + standing instructions + skills + model + sizing. No secrets. */
export interface GatewayTemplate {
  id: string;
  title: string;
  version: string;
  description: string;
  hardware: { cpu: number; ramGb: number; desktop: boolean };
  model?: { provider: string; default: string };
  persona?: string;
  instructions?: string;
  skills: TemplateSkill[];
  env: Record<string, string>;
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** Package root/templates from both src (vitest) and dist (built gateway). */
export function defaultTemplateDir(): string {
  return fileURLToPath(new URL("../templates", import.meta.url));
}

const VALID_CPU = new Set([1, 2, 4]);
const VALID_RAM_GB = new Set([2, 4, 8, 16]);

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function loadTemplate(dir: string, id: string): GatewayTemplate {
  if (!TEMPLATE_ID_RE.test(id)) throw new TemplateError(`invalid template id: ${JSON.stringify(id)}`);
  const file = join(dir, "registry", `${id}.yaml`);
  if (!existsSync(file)) throw new TemplateError(`unknown template: ${id}`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new TemplateError(`template ${id} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const doc = raw as Record<string, unknown>;
  if (str(doc["api_version"]) !== TEMPLATE_API_VERSION) throw new TemplateError(`template ${id}: api_version must be ${TEMPLATE_API_VERSION}`);
  const t = (doc["template"] ?? {}) as Record<string, unknown>;
  const name = str(t["name"]);
  if (name !== id) throw new TemplateError(`template ${id}: name must equal the file name`);
  const title = str(t["title"]);
  const version = str(t["version"]);
  const description = str(t["description"]);
  if (!title) throw new TemplateError(`template ${id}: title is required`);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new TemplateError(`template ${id}: version must be semver (e.g. 1.0.0)`);
  if (!description) throw new TemplateError(`template ${id}: description is required`);

  const hardwareRaw = (doc["hardware"] ?? {}) as Record<string, unknown>;
  const cpu = Number(hardwareRaw["cpu"] ?? 1);
  const ramGb = Number(hardwareRaw["ram_gb"] ?? 4);
  const desktop = hardwareRaw["desktop"] === true;
  if (!VALID_CPU.has(cpu)) throw new TemplateError(`template ${id}: hardware.cpu must be one of 1, 2, 4`);
  if (!VALID_RAM_GB.has(ramGb)) throw new TemplateError(`template ${id}: hardware.ram_gb must be one of 2, 4, 8, 16`);

  let model: GatewayTemplate["model"];
  if (doc["model"] !== undefined) {
    const m = doc["model"] as Record<string, unknown>;
    const provider = str(m["provider"]);
    const def = str(m["default"]);
    if (!provider || !def) throw new TemplateError(`template ${id}: model needs provider and default`);
    model = { provider, default: def };
  }

  let persona: string | undefined;
  const personaRel = str(t["persona"]);
  if (personaRel) {
    const personaFile = join(dir, "personas", personaRel.endsWith(".md") ? personaRel : `${personaRel}.md`);
    if (!personaFile.startsWith(dir) || !existsSync(personaFile)) throw new TemplateError(`template ${id}: persona file not found`);
    persona = readFileSync(personaFile, "utf8").trim();
  }

  const skillsRaw = doc["skills"] ?? [];
  if (!Array.isArray(skillsRaw)) throw new TemplateError(`template ${id}: skills must be a list`);
  const skills: TemplateSkill[] = [];
  for (const entry of skillsRaw) {
    const skillName = str(entry);
    if (!TEMPLATE_ID_RE.test(skillName)) throw new TemplateError(`template ${id}: invalid skill name ${JSON.stringify(entry)}`);
    const skillFile = join(dir, "skills", skillName, "SKILL.md");
    if (!existsSync(skillFile)) throw new TemplateError(`template ${id}: skill ${skillName} has no SKILL.md`);
    skills.push({ name: skillName, content: readFileSync(skillFile, "utf8") });
  }

  const envRaw = doc["env"] ?? {};
  if (!envRaw || typeof envRaw !== "object" || Array.isArray(envRaw)) throw new TemplateError(`template ${id}: env must be a map`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envRaw as Record<string, unknown>)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new TemplateError(`template ${id}: env.${key} must be a scalar`);
    }
    env[key] = String(value);
  }

  const instructions = str(t["instructions"]) || undefined;

  return { id, title, version, description, hardware: { cpu, ramGb, desktop }, model, persona, instructions, skills, env };
}

export class TemplateRegistry {
  constructor(
    readonly dir: string,
    private readonly byId: Map<string, GatewayTemplate>,
  ) {}

  ids(): string[] {
    return [...this.byId.keys()];
  }

  get(id: string | undefined): GatewayTemplate | undefined {
    return this.byId.get(id && TEMPLATE_ID_RE.test(id) ? id : DEFAULT_TEMPLATE_ID);
  }

  /** The template to provision with: the requested id, or default. Throws on an unknown id. */
  resolve(id: string | undefined): GatewayTemplate {
    const wanted = id && id.trim() ? id.trim() : DEFAULT_TEMPLATE_ID;
    const found = this.get(wanted);
    if (!found || found.id !== wanted) throw new TemplateError(`unknown template: ${wanted}`);
    return found;
  }
}

/** Load every registry/<id>.yaml under dir. Fails fast on any invalid template. */
export function loadTemplateRegistry(dir = defaultTemplateDir()): TemplateRegistry {
  const registryDir = join(dir, "registry");
  if (!existsSync(registryDir)) throw new TemplateError(`no template registry at ${registryDir}`);
  const ids = readdirSync(registryDir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.slice(0, -".yaml".length))
    .sort();
  if (!ids.includes(DEFAULT_TEMPLATE_ID)) throw new TemplateError(`registry is missing ${DEFAULT_TEMPLATE_ID}.yaml`);
  const byId = new Map<string, GatewayTemplate>();
  for (const id of ids) byId.set(id, loadTemplate(dir, id));
  return new TemplateRegistry(dir, byId);
}

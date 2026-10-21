import { type Logger, silentLogger } from "./logger.js";

/** Caps that keep one person's repo from filling an agent's disk or the files API. */
export const BRAIN_MAX_FILES = 200;
export const BRAIN_MAX_FILE_BYTES = 256 * 1024;
export const BRAIN_MAX_TOTAL_BYTES = 3 * 1024 * 1024;
/** Where pushed brain files land inside the agent's persistent volume. */
export const BRAIN_ROOT = "/data/brain";

const SKIP_DIR_RE = /(^|\/)(\.git|node_modules|dist|build|\.next|vendor|\.venv|venv|__pycache__|coverage)(\/|$)/i;
/** Never read or push credential-shaped files, whatever the repo says. */
const DENY_RE = /(^|\/)(\.env($|\..*)|.*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?)$/i;
const NUL = String.fromCharCode(0);
const ALLOWED_EXT = new Set([
  "md", "mdx", "txt", "rst", "adoc", "org", "csv", "tsv",
  "json", "yaml", "yml", "toml", "ini", "cfg", "conf", "config", "properties",
  "html", "htm", "css", "scss",
  "js", "mjs", "cjs", "ts", "tsx", "jsx",
  "py", "rb", "go", "rs", "java", "kt", "scala", "sh", "bash", "zsh", "sql",
  "graphql", "gql", "proto", "xml", "svg", "c", "h", "cpp", "hpp", "cs", "php", "lua", "r",
]);

/**
 * Accept `owner/repo`, a github.com URL, or a URL with `/tree/<branch>` and
 * return the canonical `owner/repo`. Anything else returns undefined; callers
 * turn that into a form error rather than silently dropping the field.
 */
export function normalizeBrainRepo(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  let v = raw.trim();
  if (!v) return undefined;
  v = v.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  v = v.split("#")[0] ?? v;
  v = v.replace(/\.git$/i, "");
  v = v.replace(/\/tree\/[^/]+.*$/, "");
  v = v.replace(/\/+$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) return undefined;
  if (v.startsWith(".") || v.includes("..")) return undefined;
  return v;
}

/** A GitHub token: non-empty, no whitespace, bounded. Empty means "unset". */
export function normalizeBrainToken(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  if (/\s/.test(v) || v.length > 200 || v.length < 8) return undefined;
  return v;
}

export interface BrainPushDeps {
  /** Fetch GitHub (injectable for tests). */
  fetchImpl?: typeof fetch;
  /** The agent's files API: write one file under /data/brain. */
  write: (path: string, content: string) => Promise<void>;
  /** Fleet-wide GitHub token used when the person supplied none (public repos need no token at all). */
  githubToken?: string;
  logger?: Logger;
}

export interface BrainPushResult {
  written: number;
  skipped: number;
}

interface TreeEntry {
  path?: string;
  type?: string;
  sha?: string;
  size?: number;
}

function githubHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "instinct-gateway",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers["authorization"] = `Bearer ${token}`;
  return headers;
}

function extOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function shouldSkip(path: string): string | undefined {
  if (path.startsWith("/") || path.split("/").includes("..")) return "unsafe path";
  if (SKIP_DIR_RE.test(path)) return "build or vcs directory";
  if (DENY_RE.test(path)) return "credential-shaped file";
  const ext = extOf(path);
  const base = path.split("/").pop() ?? path;
  // Extensionless files (README, LICENSE) are text by convention; everything else needs an allowlisted ext.
  if (ext && !ALLOWED_EXT.has(ext)) return `unsupported .${ext} file`;
  if (!ext && base.startsWith(".") && !ALLOWED_EXT.has(base.slice(1).toLowerCase())) return "unsupported dotfile";
  return undefined;
}

/**
 * Pull a GitHub repo's text files and write them into the agent's volume under
 * /data/brain, so the person's company knowledge is on disk at first boot.
 *
 * Public repos need no token; private ones use the person's own token (fleet
 * fallback token for the operator's own repos). Credential-shaped files and
 * binaries are never fetched. Caps (file count, per-file and total bytes) are
 * enforced while walking, so one huge repo cannot overrun the agent.
 */
export async function pushBrain(repo: string, token: string | undefined, deps: BrainPushDeps): Promise<BrainPushResult> {
  const log = deps.logger ?? silentLogger;
  const f = deps.fetchImpl ?? globalThis.fetch;
  const auth = token ?? deps.githubToken;
  const headers = githubHeaders(auth);

  const repoRes = await f(`https://api.github.com/repos/${repo}`, { headers });
  if (repoRes.status === 404) {
    throw new Error(`GitHub repo ${repo} was not found (a private repo needs a valid token)`);
  }
  if (!repoRes.ok) throw new Error(`GitHub repo lookup failed: ${repoRes.status}`);
  const repoInfo = (await repoRes.json()) as { default_branch?: string };
  const branch = repoInfo.default_branch;
  if (!branch) throw new Error(`GitHub repo ${repo} has no default branch`);

  const treeRes = await f(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers });
  if (!treeRes.ok) throw new Error(`GitHub tree fetch failed: ${treeRes.status}`);
  const tree = (await treeRes.json()) as { tree?: TreeEntry[] };
  const entries = (tree.tree ?? []).filter((e) => e.type === "blob" && e.path && e.sha);

  let written = 0;
  let skipped = 0;
  let total = 0;
  for (const entry of entries) {
    const path = entry.path ?? "";
    if (shouldSkip(path)) {
      skipped++;
      continue;
    }
    if (written >= BRAIN_MAX_FILES) {
      skipped++;
      continue;
    }
    if (typeof entry.size === "number" && entry.size > BRAIN_MAX_FILE_BYTES) {
      skipped++;
      log.warn("brain.file_too_large", { repo, path, size: entry.size });
      continue;
    }
    if (total >= BRAIN_MAX_TOTAL_BYTES) {
      skipped++;
      continue;
    }
    const blobRes = await f(`https://api.github.com/repos/${repo}/git/blobs/${entry.sha}`, {
      headers: { ...headers, accept: "application/vnd.github.raw" },
    });
    if (!blobRes.ok) {
      skipped++;
      log.warn("brain.blob_failed", { repo, path, status: blobRes.status });
      continue;
    }
    const bytes = Buffer.from(await blobRes.arrayBuffer());
    if (bytes.length > BRAIN_MAX_FILE_BYTES) {
      skipped++;
      continue;
    }
    const text = bytes.toString("utf8");
    if (text.includes(NUL)) {
      skipped++;
      continue;
    }
    await deps.write(`${BRAIN_ROOT}/${path}`, text);
    written++;
    total += bytes.length;
  }
  log.info("brain.pushed", { repo, written, skipped, bytes: total });
  return { written, skipped };
}

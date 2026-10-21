import { describe, expect, it } from "vitest";
import { BRAIN_MAX_FILE_BYTES, BRAIN_ROOT, normalizeBrainRepo, normalizeBrainToken, pushBrain } from "../src/brain.js";

interface Call {
  url: string;
  headers: Record<string, string>;
}

function githubFetch(tree: unknown, blobs: Record<string, string>, opts: { repoStatus?: number } = {}): { calls: Call[]; fetchImpl: typeof fetch; written: Array<{ path: string; content: string }> } {
  const calls: Call[] = [];
  const written: Array<{ path: string; content: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, headers });
    if (url.match(/https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/)) {
      if (opts.repoStatus) return Response.json({ message: "Not Found" }, { status: opts.repoStatus });
      return Response.json({ default_branch: "main" }, { status: 200 });
    }
    if (url.includes("/git/trees/")) return Response.json(tree, { status: 200 });
    if (url.includes("/git/blobs/")) {
      const sha = url.split("/").pop() ?? "";
      return new Response(blobs[sha] ?? "missing", { status: blobs[sha] !== undefined ? 200 : 404 });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl, written };
}

async function pushWith(tree: unknown, blobs: Record<string, string>, token?: string, opts: { repoStatus?: number; githubToken?: string } = {}) {
  const mock = githubFetch(tree, blobs, opts);
  const result = await pushBrain("acme/handbook", token, {
    fetchImpl: mock.fetchImpl,
    githubToken: opts.githubToken,
    write: async (path, content) => {
      mock.written.push({ path, content });
    },
  });
  return { ...mock, result };
}

describe("normalizeBrainRepo", () => {
  it("accepts owner/repo, URLs and branch URLs", () => {
    expect(normalizeBrainRepo("acme/handbook")).toBe("acme/handbook");
    expect(normalizeBrainRepo(" https://github.com/acme/handbook ")).toBe("acme/handbook");
    expect(normalizeBrainRepo("https://www.github.com/acme/handbook.git")).toBe("acme/handbook");
    expect(normalizeBrainRepo("https://github.com/acme/handbook/tree/main/docs")).toBe("acme/handbook");
    expect(normalizeBrainRepo("http://github.com/acme/handbook#readme")).toBe("acme/handbook");
  });

  it("rejects anything that is not a repo path", () => {
    expect(normalizeBrainRepo(undefined)).toBeUndefined();
    expect(normalizeBrainRepo("")).toBeUndefined();
    expect(normalizeBrainRepo("   ")).toBeUndefined();
    expect(normalizeBrainRepo("just-a-name")).toBeUndefined();
    expect(normalizeBrainRepo("a/b/c")).toBeUndefined();
    expect(normalizeBrainRepo("../../etc/passwd")).toBeUndefined();
    expect(normalizeBrainRepo("acme/..")).toBeUndefined();
    expect(normalizeBrainRepo("https://gitlab.com/acme/handbook")).toBeUndefined();
  });
});

describe("normalizeBrainToken", () => {
  it("accepts a plain token and rejects broken ones", () => {
    expect(normalizeBrainToken("ghp_abcdefgh123456")).toBe("ghp_abcdefgh123456");
    expect(normalizeBrainToken("")).toBeUndefined();
    expect(normalizeBrainToken("short")).toBeUndefined();
    expect(normalizeBrainToken("has spaces inside")).toBeUndefined();
    expect(normalizeBrainToken("x".repeat(300))).toBeUndefined();
    expect(normalizeBrainToken(undefined)).toBeUndefined();
  });
});

describe("pushBrain", () => {
  it("writes text files under /data/brain and skips build, credential and binary files", async () => {
    const tree = {
      tree: [
        { path: "README.md", type: "blob", sha: "s1", size: 12 },
        { path: "sub/handbook.md", type: "blob", sha: "s2", size: 20 },
        { path: "node_modules/pkg/readme.md", type: "blob", sha: "s3", size: 10 },
        { path: ".git/config", type: "blob", sha: "s4", size: 10 },
        { path: ".env", type: "blob", sha: "s5", size: 10 },
        { path: "secrets/id_rsa", type: "blob", sha: "s6", size: 10 },
        { path: "logo.png", type: "blob", sha: "s7", size: 10 },
        { path: "huge.txt", type: "blob", sha: "s8", size: BRAIN_MAX_FILE_BYTES + 1 },
        { path: "docs/nested.md", type: "blob", sha: "s9", size: 8 },
        { path: "only-dir", type: "tree", sha: "t1" },
      ],
    };
    const { result, written, calls } = await pushWith(tree, {
      s1: "Hello",
      s2: "# Handbook",
      s9: "Details",
      s3: "SHOULD NOT FETCH",
      s4: "SHOULD NOT FETCH",
      s5: "SHOULD NOT FETCH",
      s6: "SHOULD NOT FETCH",
      s7: "SHOULD NOT FETCH",
      s8: "SHOULD NOT FETCH",
    });

    expect(written).toEqual([
      { path: `${BRAIN_ROOT}/README.md`, content: "Hello" },
      { path: `${BRAIN_ROOT}/sub/handbook.md`, content: "# Handbook" },
      { path: `${BRAIN_ROOT}/docs/nested.md`, content: "Details" },
    ]);
    expect(result.written).toBe(3);
    // 9 blobs: 3 written, 6 skipped (tree entries are filtered before the walk).
    expect(result.skipped).toBe(6);

    const blobUrls = calls.map((c) => c.url).filter((u) => u.includes("/git/blobs/"));
    expect(blobUrls).toHaveLength(3);
    expect(blobUrls.some((u) => u.endsWith("/s3"))).toBe(false);
    expect(blobUrls.some((u) => u.endsWith("/s8"))).toBe(false);
  });

  it("sends the person's token as the bearer, falling back to the fleet token", async () => {
    const tree = { tree: [{ path: "a.md", type: "blob", sha: "s1", size: 3 }] };
    const mine = await pushWith(tree, { s1: "abc" }, "ghp_mine");
    expect(mine.calls[0]?.headers["authorization"]).toBe("Bearer ghp_mine");

    const fleet = await pushWith(tree, { s1: "abc" }, undefined, { githubToken: "ghp_fleet" });
    expect(fleet.calls[0]?.headers["authorization"]).toBe("Bearer ghp_fleet");

    const anon = await pushWith(tree, { s1: "abc" });
    expect(anon.calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("fails loudly when the repo does not exist", async () => {
    await expect(pushWith({ tree: [] }, {}, undefined, { repoStatus: 404 })).rejects.toThrow(/not found/);
  });

  it("skips files whose bytes contain NUL rather than pushing garbage", async () => {
    const tree = { tree: [{ path: "binary.txt", type: "blob", sha: "s1", size: 5 }] };
    const { result, written } = await pushWith(tree, { s1: "a\u0000b" });
    expect(written).toHaveLength(0);
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

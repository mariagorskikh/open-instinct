export interface PostizClientOptions {
  /** Base URL of the Postiz public API, e.g. https://scheduler.foundersynergy.network/api */
  baseUrl: string;
  /** The person's own Postiz API key (BYOK). Sent raw in Authorization — Postiz rejects Bearer. */
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class PostizApiError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`Postiz ${status}: ${detail}`);
    this.name = "PostizApiError";
  }
}

/** Thin client for the Postiz public API v1. One instance per request — the key is per-person. */
export class PostizClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PostizClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        // Postiz wants the raw key in Authorization (no Bearer prefix).
        Authorization: this.apiKey,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new PostizApiError(res.status, text.slice(0, 500) || res.statusText);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}

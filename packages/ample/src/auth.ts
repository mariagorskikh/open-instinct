/**
 * Ample credentials. An agent credential (client id + secret from
 * `ample auth agent create`) never expires and is exchanged for a short-lived
 * access token before each command; a plain token is passed through as is.
 */

export const DEFAULT_API_URL = "https://api.ample.computer";

export type AmpleCredentials = { token: string } | { clientId: string; clientSecret: string };

/** Renew this long before the token's stated expiry, so a long deploy never starts on a stale one. */
const RENEW_MARGIN_MS = 60_000;

export class AmpleAuth {
  private cached?: { token: string; expiresAt: number };

  constructor(
    private readonly credentials: AmpleCredentials,
    private readonly apiUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async token(signal?: AbortSignal): Promise<string> {
    if ("token" in this.credentials) return this.credentials.token;
    if (this.cached && this.cached.expiresAt - RENEW_MARGIN_MS > this.now()) return this.cached.token;

    const response = await this.fetchImpl(`${this.apiUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        resource: `${this.apiUrl}/mcp`,
      }),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    // Never echo the response body: an auth error is not worth risking the secret.
    if (!response.ok) throw new Error(`Ample sign-in failed with HTTP ${response.status}. Check AMPLE_CLIENT_ID and AMPLE_CLIENT_SECRET.`);
    const value = (await response.json().catch(() => undefined)) as { access_token?: unknown; expires_in?: unknown } | undefined;
    const token = value?.access_token;
    const ttl = value?.expires_in;
    if (typeof token !== "string" || token.length === 0 || typeof ttl !== "number" || ttl <= 0) {
      throw new Error("Ample sign-in returned no access token.");
    }
    this.cached = { token, expiresAt: this.now() + ttl * 1000 };
    return token;
  }
}

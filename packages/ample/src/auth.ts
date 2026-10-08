/**
 * Ample credentials. An agent credential (client id + secret) is exchanged for a
 * short-lived access token before each command; a plain token is passed through
 * as is. In signup mode the credential is the agent's own account (account.ts).
 */
import type { SignupAccount } from "./account.js";

export const DEFAULT_API_URL = "https://api.ample.computer";

export type AmpleCredentials = { token: string } | { clientId: string; clientSecret: string };

/** Renew this long before the token's stated expiry, so a long deploy never starts on a stale one. */
const RENEW_MARGIN_MS = 60_000;

/** Ample no longer knows the client: its account was deleted or the credential revoked. */
class InvalidClient extends Error {}

export interface IssuedToken {
  token: string;
  /** Something the owner should hear about, such as a new account and its claim link. */
  notice?: string;
}

export class AmpleAuth {
  private cached?: { clientId: string; token: string; expiresAt: number };

  constructor(
    private readonly source: { credentials: AmpleCredentials } | { signup: SignupAccount },
    private readonly apiUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Ample refused the current access token (its account may be gone): fetch a new one next time. */
  dropToken(): void {
    this.cached = undefined;
  }

  /** Whether `accountId` belonged to this agent before it had to sign up again. */
  retired(accountId: string): boolean {
    return "signup" in this.source && this.source.signup.retired(accountId);
  }

  /** Whether there is an account to act on yet. Only a signup-mode agent that never deployed has none. */
  hasAccount(): boolean {
    return "credentials" in this.source || this.source.signup.current() !== undefined;
  }

  async token(signal?: AbortSignal): Promise<IssuedToken> {
    if ("credentials" in this.source) {
      const credentials = this.source.credentials;
      if ("token" in credentials) return { token: credentials.token };
      return { token: await this.exchange(credentials, signal).catch(rethrowForOperator) };
    }

    const signup = this.source.signup;
    const first = await signup.ensure(signal);
    try {
      return { token: await this.exchange(first.account, signal), ...(first.notice ? { notice: first.notice } : {}) };
    } catch (error) {
      if (!(error instanceof InvalidClient)) throw error;
      // Ample deletes an account nobody claimed within two days. Start a new one.
      signup.forget();
      this.cached = undefined;
      const fresh = await signup.ensure(signal);
      const token = await this.exchange(fresh.account, signal);
      const lost = "The owner's previous Ample account was deleted because nobody claimed it within two days, so the sites in it are gone.";
      return { token, notice: `${lost} ${fresh.notice ?? ""}`.trim() };
    }
  }

  private async exchange(credentials: { clientId: string; clientSecret: string }, signal?: AbortSignal): Promise<string> {
    const cached = this.cached;
    if (cached && cached.clientId === credentials.clientId && cached.expiresAt - RENEW_MARGIN_MS > this.now()) return cached.token;

    const response = await this.fetchImpl(`${this.apiUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": "open-instinct/0.1" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        resource: `${this.apiUrl}/mcp`,
      }),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    // Never echo the response body: an auth error is not worth risking the secret.
    if (!response.ok) {
      const code = response.status === 401 ? await errorCode(response) : undefined;
      if (code === "invalid_client") throw new InvalidClient(`Ample sign-in failed with HTTP ${response.status}.`);
      throw new Error(`Ample sign-in failed with HTTP ${response.status}.`);
    }
    const value = (await response.json().catch(() => undefined)) as { access_token?: unknown; expires_in?: unknown } | undefined;
    const token = value?.access_token;
    const ttl = value?.expires_in;
    if (typeof token !== "string" || token.length === 0 || typeof ttl !== "number" || ttl <= 0) {
      throw new Error("Ample sign-in returned no access token.");
    }
    this.cached = { clientId: credentials.clientId, token, expiresAt: this.now() + ttl * 1000 };
    return token;
  }
}

/** A shared credential that stopped working is the operator's to fix. */
function rethrowForOperator(error: unknown): never {
  if (error instanceof InvalidClient) {
    throw new Error(`${error.message} Check AMPLE_CLIENT_ID and AMPLE_CLIENT_SECRET.`);
  }
  throw error;
}

/** The OAuth error code only (`{"error": "invalid_client"}`); the description is never read. */
async function errorCode(response: Response): Promise<string | undefined> {
  const value = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  return typeof value?.error === "string" ? value.error : undefined;
}

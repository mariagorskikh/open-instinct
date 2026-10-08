/**
 * An Ample account of the agent's own. With AMPLE_SIGNUP=1 and no shared
 * credential, the agent signs up the first time its owner asks for a site, so
 * every person's agent deploys into an account nobody else can see. The owner
 * keeps it by claiming it (confirming their email); Ample deletes an unclaimed
 * account two days after signup, and the next deploy then signs up again.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface StoredAccount {
  accountId: string;
  clientId: string;
  clientSecret: string;
  /** Where the owner confirms their email to keep the account. Absent once claimed. */
  claimUrl?: string;
  /** When Ample deletes the account unless it is claimed. */
  expiresAt?: string;
  /** The address Ample emailed a claim link to at signup. */
  claimEmailedTo?: string;
  createdAt: string;
}

interface AccountFile {
  account?: StoredAccount;
  /** A signup in flight: Ample returns the same account for the same key for ten minutes. */
  pending?: { requestKey: string; startedAt: string };
  /** Accounts this agent had before, now gone. Their deploy records in app folders are stale. */
  retired?: string[];
}

/** Ample keeps a signup receipt for ten minutes; reuse the key a little less long than that. */
const RECEIPT_REUSE_MS = 9 * 60_000;

export interface SignupOptions {
  /** JSON file for the account, under the agent's secrets directory. Written 0600. */
  file: string;
  apiUrl: string;
  /** Label Ample puts in the account name. */
  name?: string;
  /** The owner's email: Ample sends them a claim link right after signup. */
  ownerEmail?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class SignupAccount {
  private inflight?: Promise<{ account: StoredAccount; notice: string }>;

  constructor(private readonly options: SignupOptions) {}

  /** The stored account, without signing up. */
  current(): StoredAccount | undefined {
    return this.read().account;
  }

  /** The stored account, signing up first if there is none. `notice` is set only when this call signed up. */
  async ensure(signal?: AbortSignal): Promise<{ account: StoredAccount; notice?: string }> {
    const existing = this.current();
    if (existing) return { account: existing };
    // One agent process: concurrent tool calls share one signup instead of making two accounts.
    this.inflight ??= this.signup(signal).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** The account is gone (Ample deleted it unclaimed, or its credential was revoked). The next ensure() signs up again. */
  forget(): void {
    const file = this.read();
    if (!file.account) return;
    this.write({ retired: [...(file.retired ?? []), file.account.accountId] });
  }

  /** Whether `accountId` is an account this agent had before and lost. */
  retired(accountId: string): boolean {
    return this.read().retired?.includes(accountId) ?? false;
  }

  private async signup(signal?: AbortSignal): Promise<{ account: StoredAccount; notice: string }> {
    const now = this.options.now ?? (() => new Date());
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const file = this.read();
    const reusable = file.pending && now().getTime() - Date.parse(file.pending.startedAt) < RECEIPT_REUSE_MS;
    const pending = reusable && file.pending ? file.pending : { requestKey: randomUUID(), startedAt: now().toISOString() };
    // Saved before the request, so a crash or timeout retries with the same key and gets the same account.
    this.write({ pending, ...(file.retired ? { retired: file.retired } : {}) });

    const response = await fetchImpl(`${this.options.apiUrl}/v1/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "open-instinct/0.1" },
      body: JSON.stringify({ name: this.options.name ?? "open-instinct", request_key: pending.requestKey }),
      signal: signal ?? AbortSignal.timeout(130_000),
    });
    // The body may hold credentials on success only; an error body is never echoed.
    if (!response.ok) throw new Error(`Ample signup failed with HTTP ${response.status}.`);
    const value = (await response.json().catch(() => undefined)) as Record<string, any> | undefined;
    const clientId = value?.["credentials"]?.["client_id"];
    const clientSecret = value?.["credentials"]?.["client_secret"];
    const accountId = value?.["account_id"];
    if (typeof clientId !== "string" || typeof clientSecret !== "string" || typeof accountId !== "string") {
      throw new Error("Ample signup returned no credentials.");
    }
    const account: StoredAccount = {
      accountId,
      clientId,
      clientSecret,
      ...(typeof value?.["claim_url"] === "string" ? { claimUrl: value["claim_url"] } : {}),
      ...(typeof value?.["account_expires_at"] === "string" ? { expiresAt: value["account_expires_at"] } : {}),
      createdAt: now().toISOString(),
    };

    const email = this.options.ownerEmail;
    const accessToken = value?.["access_token"];
    if (email && typeof accessToken === "string") {
      const emailed = await this.emailClaimLink(accessToken, email, fetchImpl, signal);
      if (emailed) account.claimEmailedTo = email;
    }
    this.write({ account, ...(file.retired ? { retired: file.retired } : {}) });

    const keep = account.claimUrl
      ? `Send the owner this link once so they keep their sites: ${account.claimUrl} (they confirm their email there).`
      : "";
    const mailed = account.claimEmailedTo ? ` Ample also emailed a claim link to ${account.claimEmailedTo}; it works for 30 minutes.` : "";
    return {
      account,
      notice: `Created an Ample account for the owner's sites. It is deleted two days after signup unless the owner claims it. ${keep}${mailed}`.trim(),
    };
  }

  private async emailClaimLink(token: string, email: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetchImpl(`${this.options.apiUrl}/v1/auth/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "open-instinct/0.1" },
        body: JSON.stringify({ email }),
        signal: signal ?? AbortSignal.timeout(30_000),
      });
      if (!response.ok) return false;
      const value = (await response.json().catch(() => undefined)) as { email_sent?: unknown } | undefined;
      return value?.email_sent === true;
    } catch {
      // The claim link in the deploy result still works; an email is a convenience.
      return false;
    }
  }

  private read(): AccountFile {
    try {
      return JSON.parse(fs.readFileSync(this.options.file, "utf8")) as AccountFile;
    } catch {
      return {};
    }
  }

  private write(value: AccountFile): void {
    const file = this.options.file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    // writeFileSync ignores mode on an existing file, so set it again.
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  }
}

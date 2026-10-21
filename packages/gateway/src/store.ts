import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One signed-up person. Secrets (identity key, signing key) never leave the gateway process. */
export interface UserRecord {
  id: string;
  name: string;
  phone: string;
  email?: string;
  handle: string;
  identityId: string;
  identityApiKey: string;
  signingKey: string;
  /** Signing key returned by the webhook subscription, when Inkbox hands one back. Tried after `signingKey`. */
  webhookSigningKey?: string;
  webhookSubscriptionId?: string;
  maritimeAgentId?: string;
  maritimeProjectId?: string;
  /** Deploy template applied at provision time (registry id). Absent on pre-template records. */
  templateId?: string;
  /** Company brain: GitHub repo (owner/repo) whose text files are pushed to /data/brain at provision. */
  brainRepo?: string;
  /** GitHub token for a private brain repo. Kept like other secrets: never logged, never echoed back. */
  brainToken?: string;
  /** Composio connected account id for the executor toolkit (session user = handle). Reused while active. */
  composioAccountId?: string;
  createdAt: string;
  updatedAt?: string;
  status: "provisioning" | "ready" | "error";
  error?: string;
}

interface StoreFile {
  version: 1;
  users: UserRecord[];
}

/**
 * JSON-file user store. The file holds API keys, so it is written with 0600
 * permissions through a temp file and rename, which keeps a crash from leaving
 * a half-written file behind.
 */
export class UserStore {
  readonly dir: string;
  readonly file: string;
  private cache: Map<string, UserRecord> | undefined;

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, "users.json");
  }

  all(): UserRecord[] {
    return [...this.load().values()].map(clone);
  }

  get(id: string): UserRecord | undefined {
    const u = this.load().get(id);
    return u ? clone(u) : undefined;
  }

  byHandle(handle: string): UserRecord | undefined {
    const h = handle.toLowerCase();
    for (const u of this.load().values()) if (u.handle.toLowerCase() === h) return clone(u);
    return undefined;
  }

  byIdentityId(identityId: string): UserRecord | undefined {
    for (const u of this.load().values()) if (u.identityId === identityId) return clone(u);
    return undefined;
  }

  /** A record whose phone is not known yet (`""`) is never matched. */
  byPhone(phone: string): UserRecord | undefined {
    if (!phone) return undefined;
    for (const u of this.load().values()) if (u.phone === phone) return clone(u);
    return undefined;
  }

  save(u: UserRecord): UserRecord {
    const next = { ...clone(u), updatedAt: new Date().toISOString() };
    this.load().set(next.id, next);
    this.persist();
    return clone(next);
  }

  remove(id: string): boolean {
    const removed = this.load().delete(id);
    if (removed) this.persist();
    return removed;
  }

  private load(): Map<string, UserRecord> {
    if (this.cache) return this.cache;
    const map = new Map<string, UserRecord>();
    if (existsSync(this.file)) {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StoreFile | UserRecord[];
      const users = Array.isArray(parsed) ? parsed : parsed.users ?? [];
      for (const u of users) map.set(u.id, u);
    }
    this.cache = map;
    return map;
  }

  private persist(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const body: StoreFile = { version: 1, users: [...this.load().values()] };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
    // rename keeps the temp file's mode, but an older file may have been created more loosely.
    chmodSync(this.file, 0o600);
  }
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * Strip anything a browser or a log line must not see. The name and the
 * provisioning error text stay out too: the id can leak, and this JSON must not
 * turn a leaked id into a profile.
 */
export function publicUser(u: UserRecord): Record<string, unknown> {
  return {
    id: u.id,
    handle: u.handle,
    phoneMasked: maskPhone(u.phone),
    status: u.status,
    hasError: u.status === "error",
    hasAgent: Boolean(u.maritimeAgentId),
    templateId: u.templateId ?? "default",
    hasBrain: Boolean(u.brainRepo),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return `${phone.slice(0, 2)}${"•".repeat(Math.max(0, phone.length - 6))}${phone.slice(-4)}`;
}

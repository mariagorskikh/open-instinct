/**
 * Append-only audit log. Every tool call, policy decision, outbound message and
 * spend lands here so the owner can ask "what did you do today" and so the spend
 * policy can compute today's total without a database.
 */
import type { StateDir } from "./state.js";
import type { AuditEntry, AuditKind } from "./types.js";

const FILE = "audit.jsonl";

/** Calendar date of `d` in `tz` as YYYY-MM-DD. Falls back to UTC on a bad tz. */
export function localDate(d: Date, tz: string): string {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  // en-CA formats as YYYY-MM-DD already.
  return fmt.format(d);
}

/** Called after each entry is written, for sinks such as the audit webhook. */
export type AuditListener = (entry: AuditEntry) => void;

export class AuditLog {
  private readonly state: StateDir;
  private readonly listeners = new Set<AuditListener>();

  constructor(state: StateDir) {
    this.state = state;
  }

  append(entry: Omit<AuditEntry, "at">): void {
    const full: AuditEntry = { at: new Date().toISOString(), ...entry };
    this.state.appendLine(FILE, JSON.stringify(full));
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch {
        // A sink must never break the audit trail or the tool call that wrote it.
      }
    }
  }

  /** Hear every entry after it is written. Returns the unsubscribe function. */
  subscribe(listener: AuditListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Oldest first. `limit` keeps the most recent N after filtering. */
  read(opts: { since?: string; kinds?: AuditKind[]; limit?: number } = {}): AuditEntry[] {
    const kinds = opts.kinds ? new Set<AuditKind>(opts.kinds) : undefined;
    const since = opts.since ? Date.parse(opts.since) : undefined;
    const entries: AuditEntry[] = [];
    for (const line of this.state.readLines(FILE)) {
      let e: AuditEntry;
      try {
        e = JSON.parse(line) as AuditEntry;
      } catch {
        continue; // a torn line from a crash mid-write; skip it rather than fail the read
      }
      if (kinds && !kinds.has(e.kind)) continue;
      if (since !== undefined && !Number.isNaN(since) && Date.parse(e.at) < since) continue;
      entries.push(e);
    }
    if (opts.limit !== undefined && opts.limit >= 0 && entries.length > opts.limit) {
      return entries.slice(entries.length - opts.limit);
    }
    return entries;
  }

  /** Sum of `detail.amountUsd` over "spend" entries that fall on today's local date. */
  spentTodayUsd(tz: string, now: Date = new Date()): number {
    const today = localDate(now, tz);
    let total = 0;
    for (const e of this.read({ kinds: ["spend"] })) {
      const at = new Date(e.at);
      if (Number.isNaN(at.getTime()) || localDate(at, tz) !== today) continue;
      const amount = e.detail.amountUsd;
      if (typeof amount === "number" && Number.isFinite(amount)) total += amount;
    }
    return Math.round(total * 100) / 100;
  }
}

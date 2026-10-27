/**
 * Scheduled jobs: cron or one-shot prompts delivered to the owner conversation.
 * schedules.json is served on GET /schedules so Maritime can wake the VM; when the
 * process is awake an in-process timer fires them too. The cron matcher is small
 * and evaluated in the entry's time zone with Intl, so there is no dependency.
 */
import { randomBytes } from "node:crypto";
import type { StateDir } from "./state.js";
import type { ScheduleEntry } from "./types.js";

const FILE = "schedules.json";
const MINUTE = 60 * 1000;
const MAX_SEARCH_MINUTES = 2 * 366 * 24 * 60; // give up after two years (e.g. "0 0 30 2 *")

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Vixie rule: when both day fields are restricted a date matches if either does. */
  domAny: boolean;
  dowAny: boolean;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FULL_NAME_ABBREVIATIONS = new Map([
  ["january", "jan"],
  ["february", "feb"],
  ["march", "mar"],
  ["april", "apr"],
  ["may", "may"],
  ["june", "jun"],
  ["july", "jul"],
  ["august", "aug"],
  ["september", "sep"],
  ["october", "oct"],
  ["november", "nov"],
  ["december", "dec"],
  ["sunday", "sun"],
  ["monday", "mon"],
  ["tuesday", "tue"],
  ["wednesday", "wed"],
  ["thursday", "thu"],
  ["friday", "fri"],
  ["saturday", "sat"],
]);

function parseNumber(token: string, names: string[] | undefined, offset: number, field: string): number {
  if (names) {
    const normalized = token.toLowerCase();
    const idx = names.indexOf(FULL_NAME_ABBREVIATIONS.get(normalized) ?? normalized);
    if (idx >= 0) return idx + offset;
  }
  if (!/^\d+$/.test(token)) throw new Error(`cron: bad value "${token}" in ${field} field`);
  return Number(token);
}

interface FieldDef {
  min: number;
  max: number;
  names?: string[];
  /** Value of names[0]; 1 for months (jan=1), 0 for weekdays (sun=0). */
  nameOffset: number;
  label: string;
}

function parseField(field: string, def: FieldDef): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  let any = false;
  if (!field) throw new Error(`cron: empty ${def.label} field`);
  for (const part of field.split(",")) {
    const [rangePart, stepPart, extra] = part.split("/");
    if (!rangePart || extra !== undefined) throw new Error(`cron: bad ${def.label} field "${field}"`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (stepPart !== undefined && (!/^\d+$/.test(stepPart) || step < 1)) throw new Error(`cron: bad step "${part}" in ${def.label} field`);

    let lo: number;
    let hi: number;
    if (rangePart === "*" || rangePart === "?") {
      lo = def.min;
      hi = def.max;
      if (stepPart === undefined) any = true;
    } else if (rangePart.includes("-")) {
      const [a, b, more] = rangePart.split("-");
      if (!a || !b || more !== undefined) throw new Error(`cron: bad range "${part}" in ${def.label} field`);
      lo = parseNumber(a, def.names, def.nameOffset, def.label);
      hi = parseNumber(b, def.names, def.nameOffset, def.label);
    } else {
      lo = parseNumber(rangePart, def.names, def.nameOffset, def.label);
      // "5/15" means every 15 starting at 5, like Vixie cron.
      hi = stepPart === undefined ? lo : def.max;
    }
    if (lo < def.min || hi > def.max || lo > hi) {
      throw new Error(`cron: "${part}" out of range ${def.min}-${def.max} in ${def.label} field`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, any };
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron: expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length} in "${expr}"`);
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const minute = parseField(m, { min: 0, max: 59, nameOffset: 0, label: "minute" });
  const hour = parseField(h, { min: 0, max: 23, nameOffset: 0, label: "hour" });
  const d = parseField(dom, { min: 1, max: 31, nameOffset: 0, label: "day-of-month" });
  const month = parseField(mon, { min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1, label: "month" });
  // Sunday is both 0 and 7, so parse up to 7 and fold.
  const w = parseField(dow, { min: 0, max: 7, names: DOW_NAMES, nameOffset: 0, label: "day-of-week" });
  const dowValues = new Set<number>([...w.values].map((v) => (v === 7 ? 0 : v)));
  return { minute: minute.values, hour: hour.values, dom: d.values, month: month.values, dow: dowValues, domAny: d.any, dowAny: w.any };
}

export interface LocalParts {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
  /** YYYY-MM-DD, used to notice day boundaries. */
  date: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        weekday: "short",
      });
    } catch {
      // Unknown zone: fall back to UTC rather than crash the scheduler loop.
      f = formatterFor("UTC");
    }
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localParts(d: Date, tz: string): LocalParts {
  const parts = formatterFor(tz).formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24; // some engines print "24" for midnight
  const dow = DOW_NAMES.indexOf(get("weekday").toLowerCase().slice(0, 3));
  const year = Number(get("year"));
  const month = Number(get("month"));
  const dom = Number(get("day"));
  return {
    minute: Number(get("minute")),
    hour,
    dom,
    month,
    dow: dow < 0 ? 0 : dow,
    date: `${year}-${String(month).padStart(2, "0")}-${String(dom).padStart(2, "0")}`,
  };
}

function dayMatches(spec: CronSpec, p: LocalParts): boolean {
  if (!spec.month.has(p.month)) return false;
  const domOk = spec.dom.has(p.dom);
  const dowOk = spec.dow.has(p.dow);
  if (spec.domAny && spec.dowAny) return true;
  if (spec.domAny) return dowOk;
  if (spec.dowAny) return domOk;
  return domOk || dowOk;
}

export function cronMatches(spec: CronSpec, d: Date, tz: string): boolean {
  const p = localParts(d, tz);
  return dayMatches(spec, p) && spec.hour.has(p.hour) && spec.minute.has(p.minute);
}

/** First minute strictly after `from` that matches. Undefined if none within two years. */
export function nextCron(spec: CronSpec, from: Date, tz: string): Date | undefined {
  let t = Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE;
  let searched = 0;
  while (searched < MAX_SEARCH_MINUTES) {
    const p = localParts(new Date(t), tz);
    if (!dayMatches(spec, p)) {
      // Jump to roughly two hours before local midnight; the per-minute steps that
      // follow cross the day boundary correctly even when DST shifts the clock.
      const toMidnight = 24 * 60 - (p.hour * 60 + p.minute) - 120;
      const jump = toMidnight > 0 ? toMidnight : 1;
      t += jump * MINUTE;
      searched += jump;
      continue;
    }
    if (!spec.hour.has(p.hour)) {
      const jump = 60 - p.minute;
      t += jump * MINUTE;
      searched += jump;
      continue;
    }
    if (!spec.minute.has(p.minute)) {
      t += MINUTE;
      searched += 1;
      continue;
    }
    return new Date(t);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function newId(): string {
  return `s_${randomBytes(4).toString("hex")}`;
}

export class Scheduler {
  private readonly state: StateDir;
  private readonly now: () => Date;

  constructor(state: StateDir, opts: { now?: () => Date } = {}) {
    this.state = state;
    this.now = opts.now ?? (() => new Date());
  }

  private load(): ScheduleEntry[] {
    const raw = this.state.readJson<unknown>(FILE, []);
    return Array.isArray(raw) ? (raw as ScheduleEntry[]) : [];
  }

  private save(list: ScheduleEntry[]): void {
    this.state.writeJson(FILE, list);
  }

  list(): ScheduleEntry[] {
    return this.load().map((e) => ({ ...e }));
  }

  get(id: string): ScheduleEntry | undefined {
    const e = this.load().find((x) => x.id === id);
    return e ? { ...e } : undefined;
  }

  create(input: Omit<ScheduleEntry, "id" | "createdAt" | "nextRunAt"> & { nextRunAt?: string }): ScheduleEntry {
    if (!input.prompt || !input.prompt.trim()) throw new Error("schedule: prompt is required");
    if (input.tz && !isValidTimeZone(input.tz)) throw new Error(`schedule: unknown time zone "${input.tz}"`);
    const tz = input.tz ?? "UTC";
    let nextRunAt = input.nextRunAt;
    if (input.cron) {
      const spec = parseCron(input.cron); // throws on a bad expression
      if (!nextRunAt) nextRunAt = nextCron(spec, this.now(), tz)?.toISOString();
    } else if (!nextRunAt) {
      throw new Error("schedule: give a cron expression or a nextRunAt time");
    }
    if (nextRunAt !== undefined && Number.isNaN(Date.parse(nextRunAt))) {
      throw new Error(`schedule: bad nextRunAt "${nextRunAt}"`);
    }
    const entry: ScheduleEntry = {
      ...input,
      tz,
      id: newId(),
      createdAt: this.now().toISOString(),
    };
    if (nextRunAt !== undefined) entry.nextRunAt = new Date(nextRunAt).toISOString();
    const list = this.load();
    list.push(entry);
    this.save(list);
    return { ...entry };
  }

  delete(id: string): boolean {
    const list = this.load();
    const next = list.filter((e) => e.id !== id);
    if (next.length === list.length) return false;
    this.save(next);
    return true;
  }

  due(now: Date = this.now()): ScheduleEntry[] {
    const t = now.getTime();
    return this.load()
      .filter((e) => e.enabled && e.nextRunAt !== undefined && Date.parse(e.nextRunAt) <= t)
      .map((e) => ({ ...e }));
  }

  /** Record a run and move `nextRunAt` forward. One-shot entries are disabled. */
  markRan(id: string, now: Date = this.now()): void {
    const list = this.load();
    const e = list.find((x) => x.id === id);
    if (!e) return;
    e.lastRunAt = now.toISOString();
    const next = this.nextRun(e, now);
    if (next) e.nextRunAt = next.toISOString();
    else {
      delete e.nextRunAt;
      e.enabled = false;
    }
    this.save(list);
  }

  nextRun(entry: ScheduleEntry, from: Date): Date | undefined {
    if (entry.cron) {
      try {
        return nextCron(parseCron(entry.cron), from, entry.tz ?? "UTC");
      } catch {
        return undefined;
      }
    }
    if (entry.nextRunAt) {
      const at = new Date(entry.nextRunAt);
      return at.getTime() > from.getTime() ? at : undefined;
    }
    return undefined;
  }

  /** The shape Maritime's GET /schedules and the internal schedules push expect. */
  toMaritimeSchedules(): Array<{ id: string; nextRunAt?: string; cron?: string; tz?: string; prompt: string; enabled: boolean }> {
    return this.load().map((e) => {
      const out: { id: string; nextRunAt?: string; cron?: string; tz?: string; prompt: string; enabled: boolean } = {
        id: e.id,
        prompt: e.prompt,
        enabled: e.enabled,
      };
      if (e.nextRunAt) out.nextRunAt = e.nextRunAt;
      if (e.cron) out.cron = e.cron;
      if (e.tz) out.tz = e.tz;
      return out;
    });
  }

  /**
   * Poll for due entries. Each is marked as run before `onFire` so a slow job cannot
   * fire twice. Returns a stop function. The timer never keeps the process alive.
   */
  start(onFire: (entry: ScheduleEntry) => Promise<void>, intervalMs = 30_000): () => void {
    let running = false;
    const tick = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        for (const entry of this.due()) {
          this.markRan(entry.id);
          try {
            await onFire(entry);
          } catch {
            // The job owner (runtime) audits failures; the loop must keep going.
          }
        }
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
    void tick();
    return () => clearInterval(timer);
  }
}

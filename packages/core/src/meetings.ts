/**
 * Meetings the owner has agreed to, kept as records rather than prose in memory. Agents
 * re-proposed meetings that were already set and double-booked the owner when the only
 * record was a line in MEMORY.md; a ledger the prompt shows on every turn, with a clash
 * check on write, holds both sides to one plan.
 */
import type { StateDir } from "./state.js";

export interface Meeting {
  id: string;
  /** Who the owner meets, as the owner would say it. */
  with: string;
  /** Start, ISO 8601 with offset. */
  start: string;
  minutes: number;
  place?: string;
  note?: string;
  recordedAt: string;
}

const FILE = "meetings.json";
const DEFAULT_MINUTES = 20;

export class MeetingStore {
  constructor(private readonly state: StateDir, private readonly now: () => Date = () => new Date()) {}

  list(): Meeting[] {
    return this.state.readJson<Meeting[]>(FILE, []).slice().sort((a, b) => a.start.localeCompare(b.start));
  }

  /** Upcoming meetings (started less than their length ago), soonest first. */
  upcoming(): Meeting[] {
    const t = this.now().getTime();
    return this.list().filter((m) => Date.parse(m.start) + m.minutes * 60_000 > t);
  }

  /**
   * Record a meeting. One meeting per person: recording the same person again moves it.
   * Refuses (and returns the clash) when it overlaps a meeting with someone else.
   */
  record(input: { with: string; start: string; minutes?: number; place?: string; note?: string }): { meeting?: Meeting; clash?: Meeting; moved?: Meeting; error?: string } {
    const startMs = Date.parse(input.start);
    if (!input.with.trim()) return { error: "Say who the meeting is with." };
    if (Number.isNaN(startMs)) return { error: `"${input.start}" is not a time; give ISO 8601 with the owner's offset.` };
    const all = this.state.readJson<Meeting[]>(FILE, []);
    const same = (m: Meeting) => samePerson(m.with, input.with);
    // A move keeps the length already agreed unless a new one is given.
    const minutes = input.minutes && input.minutes > 0 ? Math.min(input.minutes, 600) : (all.find(same)?.minutes ?? DEFAULT_MINUTES);
    const clash = all.find((m) => !same(m) && overlaps(Date.parse(m.start), m.minutes, startMs, minutes));
    if (clash) return { clash };
    const moved = all.find(same);
    const meeting: Meeting = {
      id: moved?.id ?? `mtg_${startMs.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      with: input.with.trim(),
      start: new Date(startMs).toISOString(),
      minutes,
      ...(input.place?.trim() ? { place: input.place.trim() } : {}),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      recordedAt: this.now().toISOString(),
    };
    this.state.writeJson(FILE, [...all.filter((m) => !same(m)), meeting]);
    return moved ? { meeting, moved } : { meeting };
  }

  /** Remove the meeting with this person (or this id). */
  cancel(who: string): Meeting | undefined {
    const all = this.state.readJson<Meeting[]>(FILE, []);
    const found = all.find((m) => m.id === who || samePerson(m.with, who));
    if (found) this.state.writeJson(FILE, all.filter((m) => m !== found));
    return found;
  }
}

function overlaps(aStart: number, aMin: number, bStart: number, bMin: number): boolean {
  return aStart < bStart + bMin * 60_000 && bStart < aStart + aMin * 60_000;
}

/** "Victor", "Victor Alvarado" and "victor alvarado" are one person; "Victor Wu" is not "Victor Alvarado". */
export function samePerson(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  const x = norm(a);
  const y = norm(b);
  if (x.length === 0 || y.length === 0) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.every((w, i) => long[i] === w);
}

/** "Sat, Oct 17, 12:30 PM" in the owner's zone. */
export function meetingTime(m: Meeting, tz: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(m.start));
  } catch {
    return m.start;
  }
}

/** The prompt section for the owner: every upcoming meeting, and the rules that keep both sides on one plan. */
export function meetingsSection(meetings: Meeting[], tz: string | undefined): string | undefined {
  // An empty list said nothing, and old chat history about a cancelled meeting won.
  if (meetings.length === 0) return "# Meetings already set\nNone. This list is the only record of the owner's meetings: anything earlier in the chat that is not here was cancelled or never agreed.";
  const lines = meetings.map((m) => `- ${m.with}: ${meetingTime(m, tz)} (${m.minutes} min)${m.place ? `, ${m.place}` : ""}${m.note ? ` (${m.note})` : ""}`);
  return [
    "# Meetings already set",
    ...lines,
    "You recorded these once both sides said yes; if the other agent describes one differently, check with them before telling the owner anything. A new ask to meet one of these people gets \"you're already meeting <name> <when, where>\", not a new proposal. Never offer anyone a time that overlaps one of these. Move one only when the owner asks, and record the new time with meeting_record only after the other side accepts it.",
  ].join("\n");
}

/** For another agent: when the owner is busy, without names or places. */
export function busySection(meetings: Meeting[], tz: string | undefined): string | undefined {
  if (meetings.length === 0) return undefined;
  return `# Owner busy\nThe owner is already booked at: ${meetings.map((m) => meetingTime(m, tz)).join("; ")}. Never accept or offer a time that overlaps these; offer the next free slot instead. Do not say who the owner is meeting.`;
}

/** Minutes after local midnight in `tz` for an instant. */
function localMinutes(ms: number, tz: string | undefined): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", hour: "numeric", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** Clock times named in a message ("1:30 PM", "4pm", "noon"), as minutes after midnight. */
export function timesIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/gi)) {
    let h = Number(m[1]) % 12;
    if (m[3]!.toLowerCase() === "p") h += 12;
    out.push(h * 60 + Number(m[2] ?? 0));
  }
  if (/\bnoon\b/i.test(text)) out.push(12 * 60);
  // Slots said in words ("happy hour works") are times too.
  if (/\bhappy hour\b/i.test(text)) out.push(18 * 60);
  return out;
}

/**
 * A recorded meeting with someone other than `peer` that a time named in `text` falls inside.
 * Agents confirmed a second person for a slot already taken and only noticed when recording it;
 * checking the words before they are sent stops the double booking at the source. A bare clock
 * time ("1:30 PM") carries no date, so it only matches meetings in the next 24 hours.
 */
export function clashInText(meetings: Meeting[], text: string, peer: string, tz: string | undefined, now = Date.now()): Meeting | undefined {
  const times = timesIn(text);
  // Structured slots ("start": "2026-10-17T13:30:00-07:00") are exact instants.
  const instants = [...text.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g)].map((x) => Date.parse(x[0])).filter((n) => !Number.isNaN(n));
  if (times.length === 0 && instants.length === 0) return undefined;
  const others = meetings.filter((m) => !samePerson(m.with, peer));
  const hitByInstant = (t: number) => others.find((m) => t >= Date.parse(m.start) && t < Date.parse(m.start) + m.minutes * 60_000);
  const soon = others.filter((m) => Date.parse(m.start) - now < 24 * 60 * 60_000);
  const hitByClock = (t: number) => soon.find((m) => { const s0 = localMinutes(Date.parse(m.start), tz); return t >= s0 && t < s0 + m.minutes; });
  // A message that also names a free time is a counter-offer; only one where every time is taken is a clash.
  const hits = [...instants.map(hitByInstant), ...times.map(hitByClock)];
  return hits.every(Boolean) ? hits[0] : undefined;
}

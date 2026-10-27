import { describe, expect, it } from "vitest";
import { Scheduler, cronMatches, localParts, nextCron, parseCron } from "../src/scheduler.js";
import { tempState } from "./helpers.js";

const set = (...n: number[]): Set<number> => new Set(n);

describe("parseCron", () => {
  it("parses stars, lists, ranges, steps and names", () => {
    const every15 = parseCron("*/15 * * * *");
    expect(every15.minute).toEqual(set(0, 15, 30, 45));
    expect(every15.hour.size).toBe(24);
    expect(every15.domAny && every15.dowAny).toBe(true);

    const weekdays = parseCron("0 9 * * mon-fri");
    expect(weekdays.dow).toEqual(set(1, 2, 3, 4, 5));
    expect(weekdays.dowAny).toBe(false);
    expect(weekdays.domAny).toBe(true);

    expect(parseCron("0 0 1,15 * *").dom).toEqual(set(1, 15));
    expect(parseCron("30 7 * jan,jul *").month).toEqual(set(1, 7));
    expect(parseCron("30 7 * JAN-MAR *").month).toEqual(set(1, 2, 3));
    expect(parseCron("0 0 * * 7").dow).toEqual(set(0));
    expect(parseCron("0 0 * * 5-7").dow).toEqual(set(5, 6, 0));
    expect(parseCron("5/15 * * * *").minute).toEqual(set(5, 20, 35, 50));
    expect(parseCron("0 9-17/4 * * *").hour).toEqual(set(9, 13, 17));
    expect(parseCron("0 0 * * sun,sat").dow).toEqual(set(0, 6));
  });

  it("accepts exact abbreviations and full names regardless of case", () => {
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    for (const [index, name] of months.entries()) {
      for (const token of [name, name.toUpperCase(), name.slice(0, 3)]) {
        expect(parseCron(`0 9 * ${token} *`).month).toEqual(set(index + 1));
      }
    }
    for (const [index, name] of weekdays.entries()) {
      for (const token of [name, name.toUpperCase(), name.slice(0, 3)]) {
        expect(parseCron(`0 9 * * ${token}`).dow).toEqual(set(index));
      }
    }
    expect(parseCron("0 9 * January,jul *").month).toEqual(set(1, 7));
    expect(parseCron("0 9 * * Monday-Friday/2").dow).toEqual(set(1, 3, 5));
  });

  it.each([
    "0 9 * * monkey",
    "0 9 * * monsoon",
    "0 9 * janitor *",
    "0 9 * Januaryx *",
    "0 9 * * mon2",
    "0 9 * * mon,fridayx",
    "0 9 * * monkey-fri",
    "0 9 * janitor-mar *",
    "0 9 * * monkey/2",
    "0 9 * * tues",
    "0 9 * sept *",
    "0 9 * monday *",
    "0 9 * * january",
  ])("rejects malformed or misplaced names in %s", (expression) => {
    expect(() => parseCron(expression)).toThrow(/bad value/);
  });

  it("rejects malformed expressions with a readable message", () => {
    expect(() => parseCron("* * * *")).toThrow(/expected 5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("* 24 * * *")).toThrow(/out of range/);
    expect(() => parseCron("* * 0 * *")).toThrow(/out of range/);
    expect(() => parseCron("* * * 13 *")).toThrow(/out of range/);
    expect(() => parseCron("* * * * 8")).toThrow(/out of range/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/bad step/);
    expect(() => parseCron("a * * * *")).toThrow(/bad value/);
    expect(() => parseCron("10-5 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("* * * * mon-")).toThrow(/bad range/);
  });
});

describe("localParts", () => {
  it("reads wall-clock fields in the given zone", () => {
    const d = new Date("2026-10-03T12:34:00Z");
    expect(localParts(d, "UTC")).toMatchObject({ minute: 34, hour: 12, dom: 3, month: 10, dow: 6, date: "2026-10-03" });
    expect(localParts(d, "America/New_York")).toMatchObject({ hour: 8, dom: 3 });
    expect(localParts(d, "Asia/Tokyo")).toMatchObject({ hour: 21, dom: 3 });
    expect(localParts(new Date("2026-10-03T23:30:00Z"), "Asia/Tokyo")).toMatchObject({ hour: 8, dom: 4, dow: 0, date: "2026-10-04" });
    expect(localParts(new Date("2026-10-04T00:00:00Z"), "UTC").hour).toBe(0);
  });
});

describe("nextCron", () => {
  it("finds the next run in the entry's zone", () => {
    const spec = parseCron("0 9 * * *");
    expect(nextCron(spec, new Date("2026-10-03T12:00:00Z"), "America/New_York")?.toISOString()).toBe("2026-10-03T13:00:00.000Z");
    expect(nextCron(spec, new Date("2026-10-03T13:00:00Z"), "America/New_York")?.toISOString()).toBe("2026-10-04T13:00:00.000Z");
    expect(nextCron(parseCron("0 0 * * *"), new Date("2026-10-03T12:00:00Z"), "Asia/Tokyo")?.toISOString()).toBe("2026-10-03T15:00:00.000Z");
  });

  it("keeps the local hour across a DST change", () => {
    const spec = parseCron("0 9 * * *");
    // US DST ends 2026-11-01. 9am EDT is 13:00Z; 9am EST is 14:00Z.
    expect(nextCron(spec, new Date("2026-10-31T13:30:00Z"), "America/New_York")?.toISOString()).toBe("2026-11-01T14:00:00.000Z");
    // A job at 00:30 local on the transition day must not be skipped by the midnight jump.
    expect(nextCron(parseCron("30 0 * * *"), new Date("2026-10-31T20:00:00Z"), "America/New_York")?.toISOString()).toBe("2026-11-01T04:30:00.000Z");
    // Spring forward 2026-03-08: 02:30 local does not exist; the next 02:30 is the following day.
    expect(nextCron(parseCron("30 2 * * *"), new Date("2026-03-08T01:00:00Z"), "America/New_York")?.toISOString()).toBe("2026-03-09T06:30:00.000Z");
  });

  it("applies lists, ranges and the Vixie day rule", () => {
    const weekdays = parseCron("0 9 * * mon-fri");
    // 2026-10-03 is a Saturday.
    expect(nextCron(weekdays, new Date("2026-10-03T00:00:00Z"), "UTC")?.toISOString()).toBe("2026-10-05T09:00:00.000Z");
    expect(nextCron(parseCron("*/20 * * * *"), new Date("2026-10-03T10:05:00Z"), "UTC")?.toISOString()).toBe("2026-10-03T10:20:00.000Z");
    expect(nextCron(parseCron("0 0 1,15 * *"), new Date("2026-10-03T00:00:00Z"), "UTC")?.toISOString()).toBe("2026-10-15T00:00:00.000Z");
    // Both day fields restricted: match the 13th or any Friday, whichever is first.
    const fri13 = parseCron("0 0 13 * fri");
    expect(nextCron(fri13, new Date("2026-10-03T00:00:00Z"), "UTC")?.toISOString()).toBe("2026-10-09T00:00:00.000Z"); // Friday
    expect(nextCron(fri13, new Date("2026-10-09T00:00:00Z"), "UTC")?.toISOString()).toBe("2026-10-13T00:00:00.000Z"); // the 13th (Tuesday)
    expect(nextCron(parseCron("0 0 1 1 *"), new Date("2026-10-03T00:00:00Z"), "UTC")?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("is strictly after `from` and gives up on impossible dates", () => {
    const spec = parseCron("0 9 * * *");
    expect(nextCron(spec, new Date("2026-10-03T09:00:00Z"), "UTC")?.toISOString()).toBe("2026-10-04T09:00:00.000Z");
    expect(nextCron(spec, new Date("2026-10-03T08:59:30Z"), "UTC")?.toISOString()).toBe("2026-10-03T09:00:00.000Z");
    expect(nextCron(parseCron("0 0 30 2 *"), new Date("2026-10-03T00:00:00Z"), "UTC")).toBeUndefined();
  });

  it("cronMatches agrees with nextCron", () => {
    const spec = parseCron("0 9 * * mon-fri");
    expect(cronMatches(spec, new Date("2026-10-05T13:00:00Z"), "America/New_York")).toBe(true);
    expect(cronMatches(spec, new Date("2026-10-05T13:01:00Z"), "America/New_York")).toBe(false);
    expect(cronMatches(spec, new Date("2026-10-03T13:00:00Z"), "America/New_York")).toBe(false);
  });
});

describe("Scheduler store", () => {
  it("creates cron entries with a computed nextRunAt and advances them", () => {
    let now = new Date("2026-10-03T12:00:00Z");
    const s = new Scheduler(tempState(), { now: () => now });
    const e = s.create({ name: "morning", enabled: true, cron: "0 9 * * *", tz: "America/New_York", prompt: "Send my morning brief" });
    expect(e.id).toMatch(/^s_/);
    expect(e.nextRunAt).toBe("2026-10-03T13:00:00.000Z");
    expect(s.list()).toHaveLength(1);
    expect(s.due()).toHaveLength(0);

    now = new Date("2026-10-03T13:00:30Z");
    expect(s.due().map((x) => x.id)).toEqual([e.id]);
    s.markRan(e.id);
    const after = s.get(e.id)!;
    expect(after.lastRunAt).toBe(now.toISOString());
    expect(after.nextRunAt).toBe("2026-10-04T13:00:00.000Z");
    expect(after.enabled).toBe(true);
    expect(s.due()).toHaveLength(0);
  });

  it("disables one-shot entries after they run", () => {
    let now = new Date("2026-10-03T12:00:00Z");
    const s = new Scheduler(tempState(), { now: () => now });
    const e = s.create({ enabled: true, prompt: "Remind me to call mom", nextRunAt: "2026-10-03T18:00:00Z" });
    expect(e.cron).toBeUndefined();
    expect(e.nextRunAt).toBe("2026-10-03T18:00:00.000Z");
    now = new Date("2026-10-03T18:00:05Z");
    expect(s.due()).toHaveLength(1);
    s.markRan(e.id);
    const after = s.get(e.id)!;
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeUndefined();
    expect(s.due()).toHaveLength(0);
  });

  it("ignores disabled entries and deletes", () => {
    const s = new Scheduler(tempState(), { now: () => new Date("2026-10-03T12:00:00Z") });
    const e = s.create({ enabled: false, prompt: "x", nextRunAt: "2026-10-01T00:00:00Z" });
    expect(s.due()).toHaveLength(0);
    expect(s.delete(e.id)).toBe(true);
    expect(s.delete(e.id)).toBe(false);
    expect(s.list()).toHaveLength(0);
  });

  it("validates input", () => {
    const s = new Scheduler(tempState());
    expect(() => s.create({ enabled: true, prompt: "x", cron: "bad" })).toThrow(/cron/);
    expect(() => s.create({ enabled: true, prompt: "x" })).toThrow(/cron expression or a nextRunAt/);
    expect(() => s.create({ enabled: true, prompt: "x", cron: "0 9 * * *", tz: "Mars/Olympus" })).toThrow(/time zone/);
    expect(() => s.create({ enabled: true, prompt: "  ", nextRunAt: "2026-10-03T18:00:00Z" })).toThrow(/prompt/);
    expect(() => s.create({ enabled: true, prompt: "x", nextRunAt: "tomorrowish" })).toThrow(/nextRunAt/);
  });

  it("exports the Maritime schedule shape", () => {
    const s = new Scheduler(tempState(), { now: () => new Date("2026-10-03T12:00:00Z") });
    s.create({ enabled: true, prompt: "brief", cron: "0 9 * * *", tz: "UTC" });
    s.create({ enabled: true, prompt: "once", nextRunAt: "2026-10-03T18:00:00Z" });
    const out = s.toMaritimeSchedules();
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: expect.stringMatching(/^s_/), prompt: "brief", enabled: true, cron: "0 9 * * *", tz: "UTC", nextRunAt: "2026-10-04T09:00:00.000Z" });
    expect(out[1]).toEqual({ id: expect.any(String), prompt: "once", enabled: true, tz: "UTC", nextRunAt: "2026-10-03T18:00:00.000Z" });
    expect(Object.keys(out[1]!)).not.toContain("cron");
  });

  it("start() fires due jobs once each and stops cleanly", async () => {
    const s = new Scheduler(tempState(), { now: () => new Date("2026-10-03T12:00:00Z") });
    const a = s.create({ enabled: true, prompt: "a", nextRunAt: "2026-10-03T11:00:00Z" });
    s.create({ enabled: true, prompt: "later", nextRunAt: "2026-10-03T13:00:00Z" });
    const fired: string[] = [];
    const stop = s.start(async (e) => {
      fired.push(e.id);
    }, 5);
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(fired).toEqual([a.id]);
    expect(s.get(a.id)?.enabled).toBe(false);
  });
});

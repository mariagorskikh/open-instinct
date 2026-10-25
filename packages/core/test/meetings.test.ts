import { describe, expect, it } from "vitest";
import { MeetingStore, busySection, clashInText, meetingsSection, samePerson, timesIn, type Meeting } from "../src/meetings.js";
import { tempState } from "./helpers.js";

const now = () => new Date("2026-10-16T09:00:00Z");
const tz = "America/Los_Angeles";

describe("MeetingStore", () => {
  it("records, moves the same person, and refuses an overlap with someone else", () => {
    const store = new MeetingStore(tempState(), now);
    const a = store.record({ with: "Victor Alvarado", start: "2026-10-17T12:30:00-07:00", place: "the lobby cafe" });
    expect(a.meeting?.with).toBe("Victor Alvarado");
    const clash = store.record({ with: "Ingrid Solberg", start: "2026-10-17T12:40:00-07:00" });
    expect(clash.clash?.with).toBe("Victor Alvarado");
    expect(store.list()).toHaveLength(1);
    const moved = store.record({ with: "Victor", start: "2026-10-17T16:00:00-07:00", place: "outside the lobby cafe" });
    expect(moved.moved?.start).toBe("2026-10-17T19:30:00.000Z");
    expect(store.list().map((m) => m.start)).toEqual(["2026-10-17T23:00:00.000Z"]);
    expect(store.record({ with: "Ingrid Solberg", start: "2026-10-17T12:30:00-07:00" }).meeting).toBeDefined();
    expect(store.record({ with: "", start: "2026-10-17T12:30:00-07:00" }).error).toBeDefined();
    expect(store.record({ with: "X", start: "lunch" }).error).toMatch(/not a time/);
    expect(store.cancel("ingrid solberg")?.with).toBe("Ingrid Solberg");
    expect(store.cancel("nobody")).toBeUndefined();
  });

  it("matches people by name prefix, not by a shared first name", () => {
    expect(samePerson("Victor", "Victor Alvarado")).toBe(true);
    expect(samePerson("victor alvarado", "Victor Alvarado")).toBe(true);
    expect(samePerson("Victor Wu", "Victor Alvarado")).toBe(false);
  });

  it("shows the owner every meeting and another agent only busy times", () => {
    const store = new MeetingStore(tempState(), now);
    store.record({ with: "Victor Alvarado", start: "2026-10-17T12:30:00-07:00", place: "the lobby cafe" });
    const owner = meetingsSection(store.upcoming(), tz)!;
    expect(owner).toContain("- Victor Alvarado: Sat, Oct 17, 12:30 PM (20 min), the lobby cafe");
    expect(owner).toContain("you're already meeting");
    const agent = busySection(store.upcoming(), tz)!;
    expect(agent).toContain("Sat, Oct 17, 12:30 PM");
    expect(agent).not.toContain("Victor");
    expect(meetingsSection([], tz)).toContain("None. This list is the only record");
  });
});

describe("clashInText", () => {
  const tz = "America/Los_Angeles";
  const m = (who: string, start: string, minutes = 15): Meeting => ({ id: who, with: who, start, minutes, recordedAt: start });
  const booked = [m("Leo Martins", "2026-10-17T13:30:00-07:00")];

  it("finds a time already given to someone else", () => {
    expect(timesIn("Yes, Saturday at 1:30 PM in the lobby cafe works")).toEqual([13 * 60 + 30]);
    expect(clashInText(booked, "Confirmed: Saturday, October 17 at 1:30 PM in the lobby cafe", "Ingrid Solberg", tz)?.with).toBe("Leo Martins");
    expect(clashInText(booked, "yes, 1:40pm works", "Ingrid Solberg", tz)?.with).toBe("Leo Martins");
    expect(clashInText(booked, 'Sounds good {"slot":{"start":"2026-10-17T20:35:00Z"}}', "Ingrid Solberg", tz)?.with).toBe("Leo Martins");
  });

  it("reads slots said in words, and treats a free alternative as a counter-offer", () => {
    const evening = [m("Leo Martins", "2026-10-17T18:00:00-07:00", 30)];
    expect(clashInText(evening, "Happy hour works, see you there", "Ingrid Solberg", tz)?.with).toBe("Leo Martins");
    expect(clashInText(evening, "6:00 PM is taken; 6:40 PM in the Foyer instead?", "Ingrid Solberg", tz)).toBeUndefined();
  });

  it("keeps the agreed length when a meeting moves", () => {
    const store = new MeetingStore(tempState());
    store.record({ with: "Victor Alvarado", start: "2026-10-17T13:30:00-07:00", minutes: 15 });
    expect(store.record({ with: "Victor", start: "2026-10-17T16:30:00-07:00" }).meeting?.minutes).toBe(15);
  });

  it("ignores the same person, free times and texts with no time", () => {
    expect(clashInText(booked, "Yes, 1:30 PM works", "Leo Martins", tz)).toBeUndefined();
    expect(clashInText(booked, "Yes, 1:45 PM works", "Ingrid Solberg", tz)).toBeUndefined();
    expect(clashInText(booked, "Yes, see you then", "Ingrid Solberg", tz)).toBeUndefined();
  });

  it("matches a bare clock time only against meetings in the next 24 hours", () => {
    const now = Date.parse("2026-10-14T09:00:00-07:00");
    // Three days out: "1:30 PM" today is free, so no clash.
    expect(clashInText(booked, "Yes, 1:30 PM works", "Ingrid Solberg", tz, now)).toBeUndefined();
    // A dated slot still clashes however far out it is.
    expect(clashInText(booked, '{"slot":{"start":"2026-10-17T20:35:00Z"}}', "Ingrid Solberg", tz, now)?.with).toBe("Leo Martins");
    expect(clashInText(booked, "Yes, 1:30 PM works", "Ingrid Solberg", tz, Date.parse("2026-10-17T08:00:00-07:00"))?.with).toBe("Leo Martins");
  });
});

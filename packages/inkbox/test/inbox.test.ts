import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DurableInbox, RetryAfterError } from "../src/inbox.js";

const file = () => join(mkdtempSync(join(tmpdir(), "inkbox-inbox-")), "receipts.json");

describe("durable inbox", () => {
  it.skipIf(process.platform !== "win32")("persists admission when directory fsync is unavailable on Windows", () => {
    const path = file();
    const inbox = new DurableInbox({ file: path, handle: async () => {} });
    expect(() => inbox.enqueue("event", { message: "hello" })).not.toThrow();
    expect(JSON.parse(readFileSync(path, "utf8")).receipts[0]).toMatchObject({ status: "queued", payload: { message: "hello" } });
  });

  it("persists admission before processing and recovers without the original request", async () => {
    const path = file();
    const first = new DurableInbox({ file: path, handle: async () => { throw new Error("must not run"); } });
    expect(first.enqueue("event", { message: "hello" })).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).receipts[0]).toMatchObject({ status: "queued", payload: { message: "hello" } });
    const received: unknown[] = [];
    const second = new DurableInbox({ file: path, handle: async (payload) => { received.push(payload); } });
    await second.drain();
    expect(received).toEqual([{ message: "hello" }]);
    expect(second.enqueue("event", { message: "hello" })).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).receipts[0].payload).toBeUndefined();
  });

  it("retains failures for a later retry and survives restart", async () => {
    const path = file();
    const first = new DurableInbox({ file: path, now: () => 0, retryMs: 10, handle: async () => { throw new Error("unavailable"); } });
    first.enqueue("event", "body");
    await first.drain();
    expect(first.summary().queued).toBe(1);
    let calls = 0;
    const second = new DurableInbox({ file: path, now: () => 10, handle: async () => { calls++; } });
    await second.drain();
    expect(calls).toBe(1);
    expect(second.summary().done).toBe(1);
  });

  it("persists a server-requested retry delay across restart", async () => {
    const path = file();
    const first = new DurableInbox({
      file: path, now: () => 1000,
      handle: async () => { throw new RetryAfterError("rate limited", 30_000); },
    });
    first.enqueue("event", "body");
    await first.drain();
    expect(JSON.parse(readFileSync(path, "utf8")).receipts[0]).toMatchObject({
      status: "queued", attempts: 1, nextAttemptAt: 31_000, payload: "body",
    });

    let calls = 0;
    let now = 30_999;
    const second = new DurableInbox({ file: path, now: () => now, handle: async () => { calls++; } });
    await second.drain();
    expect(calls).toBe(0);
    now = 31_000;
    await second.drain();
    expect(calls).toBe(1);
    expect(second.summary().done).toBe(1);
  });

  it("wakes for a new receipt while an older receipt has a long delay", async () => {
    const received: string[] = [];
    const inbox = new DurableInbox({
      file: file(), now: () => 1000,
      handle: async (payload: string) => { received.push(payload); },
    });
    inbox.start();
    inbox.enqueue("delayed", "later", 30_000);
    inbox.enqueue("new", "now");
    await vi.waitFor(() => expect(received).toEqual(["now"]));
    expect(inbox.summary()).toMatchObject({ queued: 1, done: 1 });
    await inbox.close();
  });

  it("does not replay uncertain work or permit a duplicate to reset it", async () => {
    const path = file();
    const first = new DurableInbox({ file: path, handle: async () => { const e = new Error("interrupted"); e.name = "InboundUncertainError"; throw e; } });
    first.enqueue("event", "body");
    await first.drain();
    let calls = 0;
    const second = new DurableInbox({ file: path, handle: async () => { calls++; } });
    expect(second.enqueue("event", "body")).toBe(false);
    await second.drain();
    expect(calls).toBe(0);
    expect(second.summary().uncertain).toBe(1);
  });

  it("quarantines an interrupted receipt without invoking the handler", async () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ version: 1, receipts: [{ id: "e", payload: {}, status: "running", attempts: 1, nextAttemptAt: 0 }] }));
    let calls = 0;
    const inbox = new DurableInbox({ file: path, handle: async () => { calls++; } });
    await inbox.drain();
    expect(inbox.summary()).toMatchObject({ uncertain: 1, running: 0 });
    expect(calls).toBe(0);
  });

  it("replays interrupted forwarding only when explicitly declared idempotent", async () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ version: 1, receipts: [{ id: "e", payload: {}, status: "running", attempts: 1, nextAttemptAt: 0 }] }));
    let calls = 0;
    const inbox = new DurableInbox({ file: path, replayRunning: true, handle: async () => { calls++; } });
    await inbox.drain();
    expect(calls).toBe(1);
    expect(inbox.summary().done).toBe(1);
  });

  it("waits for active work on close without starting queued receipts", async () => {
    const received: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inbox = new DurableInbox({ file: file(), concurrency: 1, handle: async (payload: string) => {
      received.push(payload);
      await gate;
    } });
    inbox.enqueue("active", "first");
    inbox.enqueue("pending", "second");
    const drain = inbox.drain();
    let closed = false;
    const closing = inbox.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(() => inbox.enqueue("late", "third")).toThrow("closed");
    release();
    await Promise.all([closing, drain]);
    expect(received).toEqual(["first"]);
    expect(inbox.summary()).toMatchObject({ done: 1, queued: 1, running: 0 });
  });

  it("suppresses duplicates while a handler is running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const inbox = new DurableInbox({ file: file(), handle: async () => { calls++; await gate; } });
    inbox.enqueue("e", {});
    const drain = inbox.drain();
    expect(inbox.enqueue("e", {})).toBe(false);
    const other = inbox.drain();
    release();
    await Promise.all([drain, other]);
    expect(calls).toBe(1);
  });

  it("refuses admission when the store cannot be written", () => {
    const path = file();
    writeFileSync(`${path}.parent`, "not a directory");
    const inbox = new DurableInbox({ file: `${path}.parent/inbox`, handle: async () => {} });
    expect(() => inbox.enqueue("e", {})).toThrow();
    expect(inbox.summary().queued).toBe(0);
  });

  it("fails closed on corrupt durable state and bounds pending admission", () => {
    const path = file();
    writeFileSync(path, "{broken");
    expect(() => new DurableInbox({ file: path, handle: async () => {} })).toThrow();
    const inbox = new DurableInbox({ file: file(), maxPending: 1, handle: async () => {} });
    inbox.enqueue("first", {});
    expect(() => inbox.enqueue("second", {})).toThrow("full");
  });
});

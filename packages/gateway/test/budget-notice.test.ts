import { describe, expect, it } from "vitest";
import { createBudgetNotifier } from "../src/budget-notice.js";
import { imessageEvent, readyUser } from "./helpers.js";

describe("createBudgetNotifier", () => {
  it("texts the owner once per cooldown and ignores events that are not owner texts", async () => {
    let t = 1_000_000;
    const sent: Array<{ handle: string; text: string; event: Record<string, unknown> }> = [];
    const notify = createBudgetNotifier({
      text: "paused",
      cooldownMs: 60_000,
      now: () => t,
      send: async (user, event, text) => { sent.push({ handle: user.handle, text, event }); },
    });
    const user = readyUser();
    await notify(user, imessageEvent("evt_1", "conv_1"), "maritime: spend limit");
    await notify(user, imessageEvent("evt_2", "conv_1"), "maritime: spend limit");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ handle: user.handle, text: "paused" });
    t += 60_001;
    await notify(user, imessageEvent("evt_3", "conv_1"), "maritime: spend limit");
    expect(sent).toHaveLength(2);
    // Another owner has their own window.
    await notify(readyUser({ id: "usr_other", handle: "other" }), imessageEvent("evt_4", "conv_2"), "maritime: spend limit");
    expect(sent).toHaveLength(3);
    // Agent-to-agent traffic and system tasks get no notice.
    await notify(user, { id: "evt_5", event_type: "a2a.task.created", data: {} }, "maritime: spend limit");
    await notify(user, { id: "evt_6", event_type: "system.task", data: {} }, "maritime: spend limit");
    expect(sent).toHaveLength(3);
  });

  it("lets a failed send be retried on the next text", async () => {
    let fail = true;
    const sent: string[] = [];
    const notify = createBudgetNotifier({
      text: "paused",
      send: async (_user, _event, text) => { if (fail) throw new Error("inkbox down"); sent.push(text); },
    });
    const user = readyUser();
    await notify(user, imessageEvent("evt_1", "conv_1"), "r");
    expect(sent).toHaveLength(0);
    fail = false;
    await notify(user, imessageEvent("evt_2", "conv_1"), "r");
    expect(sent).toEqual(["paused"]);
  });
});

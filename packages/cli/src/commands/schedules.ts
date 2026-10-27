/** `instinct schedules ...`: proactive jobs, edited on the local data dir through core's Scheduler. */
import { parseCron, Scheduler } from "@open-instinct/core";
import { parse, str, type OptionSpec } from "../args.js";
import { table } from "../ansi.js";
import type { CliContext } from "../context.js";
import { CliError, UsageError } from "../io.js";

export const schedulesOptions: OptionSpec = {
  tz: { type: "string" },
  name: { type: "string" },
  at: { type: "string" },
};

export function validateCron(cron: string): void {
  try {
    parseCron(cron);
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
      "schedules",
    );
  }
}

export async function runSchedules(ctx: CliContext, argv: string[]): Promise<number> {
  const { values, positionals } = parse("schedules", argv, schedulesOptions);
  const [sub, ...rest] = positionals;
  const scheduler = new Scheduler(ctx.state());
  const { c } = ctx;

  switch (sub) {
    case undefined:
    case "list": {
      const entries = scheduler.list();
      if (entries.length === 0) {
        ctx.print(c.dim('No schedules. Try: instinct schedules add "0 8 * * 1-5" "Send me a morning briefing"'));
        return 0;
      }
      ctx.print(
        table(
          entries.map((e) => [
            e.id,
            e.enabled ? "on" : "off",
            e.cron ?? `once ${e.nextRunAt ?? "?"}`,
            e.tz ?? "",
            e.nextRunAt ? `next ${e.nextRunAt}` : "",
            e.name ?? e.prompt.slice(0, 50),
          ]),
        ),
      );
      return 0;
    }
    case "add": {
      const at = str(values, "at");
      const [first, ...more] = rest;
      let cron: string | undefined;
      let prompt: string;
      if (at) {
        prompt = [first, ...more].filter(Boolean).join(" ").trim();
        if (Number.isNaN(new Date(at).getTime())) throw new UsageError(`--at must be an ISO timestamp, got "${at}"`, "schedules");
      } else {
        if (!first || more.length === 0) throw new UsageError('usage: instinct schedules add "<cron>" "<prompt>" [--tz Area/City]', "schedules");
        cron = first;
        validateCron(cron);
        prompt = more.join(" ").trim();
      }
      if (!prompt) throw new UsageError("schedules add needs a prompt", "schedules");
      const tz = str(values, "tz") ?? ctx.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const entry = scheduler.create({
        name: str(values, "name"),
        enabled: true,
        cron,
        tz,
        prompt,
        nextRunAt: at ? new Date(at).toISOString() : undefined,
      });
      ctx.print(`${c.green("Scheduled")} ${entry.id}  ${entry.cron ?? `once at ${entry.nextRunAt}`}  (${entry.tz})${entry.nextRunAt ? `  next ${entry.nextRunAt}` : ""}`);
      return 0;
    }
    case "remove":
    case "delete": {
      const [id] = rest;
      if (!id) throw new UsageError("usage: instinct schedules remove <id>", "schedules");
      if (!scheduler.delete(id)) throw new CliError(`No schedule with id ${id}`);
      ctx.print(`${c.green("Removed")} ${id}`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown schedules subcommand "${sub}". Use list, add or remove.`, "schedules");
  }
}

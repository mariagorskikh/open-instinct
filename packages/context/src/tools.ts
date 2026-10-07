import { defineTool, textResult, wrapUntrusted, type RegisteredTool, type ToolResultLike } from "@open-instinct/core";
import { Type } from "typebox";

const DEFAULT_BASE_URL = "https://api.context.dev/v1";
const REQUEST_TIMEOUT_MS = 180_000;

export interface ContextToolDeps {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ContextAnswerResponse {
  partial?: boolean;
  json_content: Record<string, unknown>;
  sources: string[];
}

export function contextTools(deps: ContextToolDeps): RegisteredTool[] {
  return [contextAnswersTool(deps)];
}

function contextAnswersTool({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch }: ContextToolDeps): RegisteredTool {
  return defineTool({
    name: "context_answers",
    label: "Context.dev web answers",
    description:
      "Answer a question using current public web and webpage context. Use for live facts, sourced research, comparisons, or tasks containing URLs. Use fast by default and ultra only for deep research. Returns a structured answer and source URLs.",
    parameters: Type.Object({
      task: Type.String({ description: "The research question. Include any URLs or domains that should be read." }),
      mode: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("ultra")])),
      json_format: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "An example of the exact JSON object to return. This is not JSON Schema.",
        }),
      ),
    }),
    meta: { capabilities: ["web.read"], group: "web", describe: (args) => `answer ${describeTask(args)}` },
    execute: async ({ task, mode, json_format }, _ctx, signal) => {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/web/answers`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "open-instinct/0.1",
        },
        body: JSON.stringify({ task, mode: mode ?? "fast", ...(json_format ? { json_format } : {}) }),
        signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) return requestErrorResult(response);
      const answer = await readAnswer(response);
      if (!answer) return failedResult("Context.dev returned an invalid answer.");
      const output = JSON.stringify(answer, null, 2);
      return textResult(wrapUntrusted(output, "Context.dev web answer"));
    },
  });
}

function describeTask(args: unknown): string {
  if (!args || typeof args !== "object") return "web question";
  const task = (args as Record<string, unknown>)["task"];
  if (typeof task !== "string") return "web question";
  return task.length > 120 ? `${task.slice(0, 117)}...` : task;
}

function requestErrorResult(response: Response): ToolResultLike {
  const requestId = response.headers.get("x-request-id");
  const suffix = requestId ? ` Request ID: ${requestId}.` : "";
  return failedResult(`Context.dev request failed with HTTP ${response.status}.${suffix}`);
}

async function readAnswer(response: Response): Promise<ContextAnswerResponse | undefined> {
  const value = (await response.json().catch(() => undefined)) as Partial<ContextAnswerResponse> | undefined;
  if (!value || !value.json_content || typeof value.json_content !== "object" || !Array.isArray(value.sources)) return undefined;
  if (!value.sources.every((source) => typeof source === "string")) return undefined;
  return {
    ...(value.partial === true ? { partial: true } : {}),
    json_content: value.json_content,
    sources: value.sources,
  };
}

function failedResult(message: string): ToolResultLike {
  return { content: [{ type: "text", text: message }], isError: true };
}

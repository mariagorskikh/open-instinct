import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PostizApiError, type PostizClient } from "./postiz.js";

export type ToolResult = CallToolResult;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const POST_TYPE = {
  type: "string",
  enum: ["now", "schedule", "draft"],
  description: "now = publish immediately, schedule = publish at date, draft = save without publishing",
} as const;

const IMAGE_REF = {
  type: "object",
  properties: {
    path: { type: "string", description: "Media path from the upload_from_url tool (e.g. path returned by upload)" },
    alt: { type: "string", description: "Alt text for accessibility" },
  },
  required: ["path"],
} as const;

export const TOOLS: ToolDefinition[] = [
  {
    name: "list_integrations",
    description:
      "List the social media channels connected to this Postiz account. Returns id (use for create_post), name, provider identifier, and profile.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_groups",
    description: "List customer groups (orgs/workspaces) in Postiz. Use the group id to filter integrations.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_post",
    description:
      "Create, schedule, or draft a social media post across one or more channels. Each entry targets one integration; settings must include __type matching the provider (get the schema from get_integration_settings).",
    inputSchema: {
      type: "object",
      properties: {
        type: POST_TYPE,
        date: {
          type: "string",
          description: "ISO 8601 UTC publish time. Required for schedule; ignored for now; required for draft (stored but not published).",
        },
        shortLink: { type: "boolean", description: "Whether to use Postiz short links. Default true." },
        interval: { type: "number", description: "Seconds between posts when publishing to multiple channels. Required if type is not draft and more than one post." },
        posts: {
          type: "array",
          description: "One entry per target channel.",
          items: {
            type: "object",
            properties: {
              integrationId: { type: "string", description: "Channel id from list_integrations." },
              content: { type: "string", description: "Post text content." },
              image: { type: "array", items: IMAGE_REF, description: "Optional media attachments (upload via upload_from_url first)." },
              settings: {
                type: "object",
                description:
                  'Platform-specific settings. Must include __type (e.g. {"__type":"bluesky"}). Reddit needs subreddit[], Discord/Slack need channel, YouTube needs title+type, Instagram needs post_type.',
              },
            },
            required: ["integrationId", "content"],
          },
        },
      },
      required: ["type", "posts"],
      additionalProperties: false,
    },
  },
  {
    name: "list_posts",
    description: "List posts in the Postiz calendar (scheduled, drafts, and published).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "delete_post",
    description: "Delete a post (scheduled, draft, or published) by its id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Post id from list_posts or create_post." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_post_status",
    description: "Change a post's status (e.g. promote a draft to scheduled, or move a post back to draft).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Post id." },
        status: {
          type: "string",
          enum: ["draft", "schedule", "processing", "completed", "failed"],
          description: "New status. draft = unscheduled, schedule = ready to publish at its date.",
        },
      },
      required: ["id", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "get_integration_settings",
    description:
      "Get the required settings schema, character limits, and posting rules for one channel. Call this before create_post when the platform needs extra settings (Reddit, YouTube, Discord, etc).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Integration id from list_integrations." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "upload_from_url",
    description:
      "Upload an image or video from a public URL into Postiz. Returns the media path to attach in create_post's image field.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Publicly reachable media URL (image/jpeg, png, gif, webp, avif, bmp, tiff, or video/mp4)." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

interface CreatePostInput {
  type: string;
  date?: string;
  shortLink?: boolean;
  interval?: number;
  posts: Array<{
    integrationId: string;
    content: string;
    image?: Array<{ path: string; alt?: string }>;
    settings?: Record<string, unknown>;
  }>;
}

/** Fill settings.__type from the integration's provider identifier when the caller omitted it. */
async function withDefaultType(client: PostizClient, post: CreatePostInput["posts"][number], identifiers: Map<string, string>): Promise<Record<string, unknown>> {
  const settings = { ...(post.settings ?? {}) };
  if (typeof settings["__type"] === "string" && settings["__type"]) return settings;
  let identifier = identifiers.get(post.integrationId);
  if (identifier === undefined) {
    const integrations = await client.request<Array<{ id: string; identifier: string }>>("GET", "/public/v1/integrations");
    for (const integration of integrations) identifiers.set(integration.id, integration.identifier);
    identifier = identifiers.get(post.integrationId);
  }
  if (!identifier) throw new PostizApiError(404, `integration ${post.integrationId} not found — run list_integrations`);
  settings["__type"] = identifier;
  return settings;
}

async function callCreatePost(client: PostizClient, args: CreatePostInput): Promise<unknown> {
  if (!args.posts?.length) throw new PostizApiError(400, "posts must be a non-empty array");
  const identifiers = new Map<string, string>();
  const posts = [];
  for (const post of args.posts) {
    posts.push({
      integration: { id: post.integrationId },
      value: [{ content: post.content, image: post.image ?? [] }],
      settings: await withDefaultType(client, post, identifiers),
    });
  }
  return client.request("POST", "/public/v1/posts", {
    type: args.type,
    date: args.date ?? new Date().toISOString(),
    shortLink: args.shortLink ?? true,
    ...(args.interval === undefined ? {} : { interval: args.interval }),
    posts,
  });
}

export async function callTool(client: PostizClient, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    let result: unknown;
    switch (name) {
      case "list_integrations":
        result = await client.request("GET", "/public/v1/integrations");
        break;
      case "list_groups":
        result = await client.request("GET", "/public/v1/groups");
        break;
      case "create_post":
        result = await callCreatePost(client, args as unknown as CreatePostInput);
        break;
      case "list_posts":
        result = await client.request("GET", "/public/v1/posts");
        break;
      case "delete_post":
        result = await client.request("DELETE", `/public/v1/posts/${encodeURIComponent(String(args["id"] ?? ""))}`);
        break;
      case "update_post_status":
        result = await client.request("PUT", `/public/v1/posts/${encodeURIComponent(String(args["id"] ?? ""))}/status`, { status: String(args["status"] ?? "") });
        break;
      case "get_integration_settings":
        result = await client.request("GET", `/public/v1/integration-settings/${encodeURIComponent(String(args["id"] ?? ""))}`);
        break;
      case "upload_from_url":
        result = await client.request("POST", "/public/v1/upload-from-url", { url: String(args["url"] ?? "") });
        break;
      default:
        throw new PostizApiError(400, `unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

# @open-instinct/server

The agent process. One container, one person. It wires the core runtime to the
optional pieces (Inkbox, computer, apps, trusted network), serves Maritime's BYO
contract over HTTP, and takes Inkbox webhooks directly when self-hosted.

```
POST /chat  ─┐
             ├─> boot(): state, config, policy, approvals, audit, scheduler, contacts, memory
webhooks ────┘      └─> AgentRuntime (Pi) ── tools: core · messaging · files · computer · apps · network
                                └─> outbox: InkboxChannel (iMessage/SMS/email/A2A) or ConsoleOutbox
```

## The BYO contract

Maritime runs any image that follows these rules. This server follows them.

| Rule | Where |
|---|---|
| Bind `0.0.0.0:$PORT` when `PORT` is injected (Maritime sets 18789); loopback for a bare local run | `src/main.ts`, `src/bind.ts` |
| `GET /health` returns 200 JSON | `src/http.ts` |
| `POST /chat { message, source?, conversation_id? }` returns `{ response }` within 30 s | `src/http.ts`, reply budget in `AgentRuntime` |
| State persists under `/data` | `INSTINCT_DATA_DIR`, `resolveDataDir` |
| `python3` on PATH | `deploy/Dockerfile.agent` |
| Optional `GET /schedules` for proactive wakes | `src/http.ts`, `Scheduler.toMaritimeSchedules()` |

Long work: `/chat` waits up to `INSTINCT_REPLY_BUDGET_MS` (default 20 s). If the
model is still working, the response is a one-line acknowledgement and the final
text is sent through the outbox when the run finishes. Nothing is lost.

## Routes

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/health` | open | `{ ok: true }` |
| GET | `/` or `/status` | token | agent name, handle, model, conversations, busy, computer kind, connected apps, uptime, `pendingReplies` per chat conversation, `payments.connected` when Link is configured |
| GET | `/schedules` | token | the schedule list in Maritime's shape |
| GET | `/oauth/link/start` | token | `{ url }`: a fresh Link authorize URL; the server keeps the PKCE verifier. 404 without payments. Used by `instinct payments connect` |
| GET | `/payments/status` | token | `{ connected }`. 404 without payments. Used by `instinct payments status` |
| POST | `/chat` | token | Four cases, in this order. (1) `message` starts with `@@instinct-event@@` and the event is `{ type: "link.oauth_callback", code, state }`: the Link wallet handshake is completed, `response` is `""`. (2) The event is `{ type: "system.task", id, prompt, name?, quiet? }`: a task from whoever operates the agent (a front door that wants research done before the first text, a one-off reminder). It runs as the owner on `system:<id>` past the HTTP budget; the result is texted to the owner unless `quiet` is true, and `response` is `""` with `conversationKey` set. A runtime without `runSystemTask` answers `blocked`. (3) Any other envelope is an Inkbox event relayed by the gateway: parsed, handled, reply sent through Inkbox, `response` is `""`. (4) `source` is `"scheduled"`: a Maritime schedule wake, see below. (5) Otherwise the owner is talking on `chat:<conversation_id ?? "default">` and the reply comes back in `response`; replies the runtime finished after an earlier ack on that conversation come back in `pending`. |
| GET | `/oauth/link/callback?code&state` | open | Stripe Link redirects the owner here after they approve the wallet. Completes `wallet.handleCallback` and renders a small "Connected" page. 404 page when payments are not configured, 400 page on a missing code/state, a Link `error`, or a state mismatch. |
| POST | `/webhooks/inkbox` | signature | Raw body. Verifies `X-Inkbox-Signature` (HMAC-SHA256 over `request_id.timestamp.body`, 5 min window). 503 when no signing key is configured, 401 when invalid, else 204 at once and the event is handled in the background. |

Bodies are capped at 1 MiB (413). Bad JSON is 400. Unknown paths are 404. Errors
are JSON and never crash the process.

### Who may call /chat

`/chat`, `/status` and `/schedules` are the owner's surface: a plain message there runs
with the full owner tool set (bash, files, computer, apps, purchases), and an envelope is
trusted as a verified Inkbox event. So they are guarded twice.

1. **Token.** With `INSTINCT_CHAT_TOKEN` set (or `chatToken` passed to `createHttpServer`),
   every call must carry `Authorization: Bearer <token>` or `X-Instinct-Token: <token>`,
   compared in constant time, or it gets `401` before the body is read. Envelopes without
   the token are rejected the same way, so nobody can forge an iMessage "from" the owner's
   number. `/health`, `/webhooks/inkbox` (signed) and `/oauth/link/callback` (state-bound,
   browser redirect) never need it.
2. **Bind address.** Without a token the network is the guard. `main.ts` listens on
   `127.0.0.1` unless `PORT` or a `MARITIME_*` variable says this is a container
   (`INSTINCT_BIND` overrides). Inside a Maritime VM the port is private and only
   Maritime's own authenticated API reaches `/chat`, which is why Maritime's relay works
   without the token (Maritime cannot add our header). `deploy/docker-compose.yml`
   publishes `127.0.0.1:8080`. A warning is logged when the server binds beyond loopback
   with no token.

The Inkbox tunnel never exposes this surface. With `INSTINCT_TUNNEL=1` the server starts a
second, loopback-only listener (`listenTunnelServer`, `tunnelOnly: true`) that answers
`GET /health` and `POST /webhooks/inkbox` and returns `404` for everything else, and points
the tunnel at that. The public `https://<handle>.inkboxwire.com` URL therefore reaches
signed webhooks only. CLI and gateway code that runs its own tunnel should do the same.

### Schedule wakes

Schedules are pushed to Maritime with their prompt, and Maritime wakes a sleeping VM by
posting that prompt to `/chat` with `source: "scheduled"`. The server does not treat this as
the owner typing. It finds the entry (its id anywhere in the message, else an exact prompt
match), checks it is still due (`nextRunAt` within 90 s of now), calls
`scheduler.markRan` and then `runtime.runScheduled(entry)`, which runs the job as the owner
on `scheduled:<id>` and texts the owner the result. The HTTP response is
`{ response: "", acked: true, conversationKey: "scheduled:<id>" }`. Because the in-process
timer also marks an entry before firing it, whichever of the two sees the entry first runs
it and the other acks with `blocked: "already ran"`; a prompt that matches no entry acks with
`blocked: "unknown schedule"` and runs nothing.

## Environment

Only `server`, `gateway` and `cli` read `process.env`. Full list with comments:
[`deploy/.env.example`](../../deploy/.env.example). The ones that change what boots:

| Variable | Effect |
|---|---|
| `INSTINCT_DATA_DIR` | state root; default `/data` if it exists, else `./.instinct` |
| `INSTINCT_MODEL` | `provider/model`; default `anthropic/claude-fable-5-1`; `openai-compatible/<id>` uses `OPENAI_BASE_URL` |
| `INSTINCT_OWNER_NAME/PHONE/EMAIL/TIMEZONE`, `INSTINCT_AGENT_NAME` | seed `config.json` on first boot |
| `INKBOX_API_KEY` + `INKBOX_AGENT_HANDLE` (+ `INKBOX_IDENTITY_ID`) | outbox becomes Inkbox; messaging tools and A2A appear |
| `INKBOX_SIGNING_KEY` | webhook verification (also read from `<data>/secrets/webhook.json`) |
| `INKBOX_ADMIN_API_KEY` | invitations and contact rules; with the tunnel, auto-subscribes the webhook |
| `INSTINCT_TUNNEL=1` | open an Inkbox tunnel to a loopback webhook-only listener and print its public URL |
| `INSTINCT_CHAT_TOKEN` | bearer token for `/chat`, `/status`, `/schedules` (see "Who may call /chat") |
| `INSTINCT_BIND` | bind address override; default loopback, or `0.0.0.0` when `PORT` or `MARITIME_*` is set |
| `INSTINCT_PUBLIC_URL` | this agent's public URL, used to build the Link callback URL |
| `INSTINCT_COMPUTER` | `auto`, `desktopd`, `maritime`, `none` |
| `MARITIME_DESKTOP=1` | injected by Maritime when the VM has a desktop; `auto` then waits up to 60 s for desktopd to start instead of giving up on the first refused probe |
| `MARITIME_API_KEY`, `MARITIME_COMPUTERS_MCP_URL` | hosted computer when no in-VM desktop |
| `COMPOSIO_API_KEY`, `COMPOSIO_TOOLKITS` | Gmail, Calendar, Contacts and more through Composio; the key alone turns apps on |
| `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET`, `STRIPE_PUBLISHABLE_KEY` | all three together turn on payments (Stripe Link agent wallet, `@open-instinct/payments`) |
| `LINK_REDIRECT_URI` | where Link sends the owner back; default `INSTINCT_PUBLIC_URL` + `/oauth/link/callback`, else `http://127.0.0.1:$PORT/oauth/link/callback` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, ... | provider keys, looked up from the env the server was given (`apiKeyFor`), never from `process.env` behind its back |
| `BRAVE_SEARCH_API_KEY` | better `web_search`; DuckDuckGo otherwise |
| `KEIROLABS_API_KEY` | `web_search` through Keirolabs, used over Brave and DuckDuckGo (You.com, when set, still wins) |
| `INSTINCT_SKILLS_DIR` | SKILL.md folder; default `<repo>/skills` |
| `MARITIME_AGENT_ID`, `MARITIME_BACKEND_URL`, `MARITIME_INTERNAL_TOKEN` | injected by Maritime; schedules are pushed to the platform on boot and when they change |
| `PORT` | listen port, default 8080 (Maritime injects 18789; the image sets none) |

Without any Inkbox variables the agent still runs. Replies are printed and kept in
a `ConsoleOutbox`, which is how local development and the smoke test work.

The `chat` channel has no wire of its own: it is the dashboard or CLI waiting on the
HTTP response. Whatever the transport, replies the runtime finishes after `/chat` already
acked are held per conversation (`ConsoleOutbox.chat`, or `ChatAwareOutbox` wrapped around
the Inkbox channel) and handed back as `pending` on the next `/chat` for that conversation.
`GET /status` lists them under `pendingReplies`.

## Payments

With `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET` and `STRIPE_PUBLISHABLE_KEY` set, `boot` imports
`@open-instinct/payments`, builds a `LinkWallet` on the state dir and registers
`paymentsTools(...)`. The wallet is a Stripe Link agent wallet: the owner approves it once in
a browser and the agent can then ask Link for one-time cards for approved amounts. The
handshake:

1. The owner asks to connect payments. The tool returns `wallet.authorizeUrl()` and the
   agent texts the link.
2. The owner approves on Link. Link redirects to `LINK_REDIRECT_URI`.
3. Either that URI is this server's `GET /oauth/link/callback?code&state`, which calls
   `wallet.handleCallback(code, state)` and shows "Connected", or it is the gateway's
   callback, which relays `{ type: "link.oauth_callback", code, state }` to this agent as an
   `@@instinct-event@@` envelope on `/chat`, and the server completes the same call.

`GET /status` reports `payments: { connected }`. When the package is not installed the
server logs `payments: ... not installed; skipping` and boots without payment tools.

## Programmatic use

```ts
import { boot, createHttpServer } from "@open-instinct/server";

const app = await boot(process.env);          // { runtime, state, config, scheduler, outbox, close, ... }
const server = createHttpServer(app);
server.listen(8080, "0.0.0.0");
```

`boot(env, opts)` accepts `model`, `streamFn`, `outbox`, `logger`, `skillsDir`, `fetchImpl`
and `payments` (a payments module to wire in place of the real import) so tests and
embedders can swap the network out. `createHttpServer(app, opts)` accepts a `signingKey` or a
`signingKeyProvider` for webhooks, `chatToken` for the owner's surface and `tunnelOnly` for
the webhook-only listener; `listenTunnelServer(app, opts)` builds and binds that listener on
loopback. `bindHostFor(env)` is the bind-address rule.

`boot` also hands core two hooks it cannot build itself (core must not import the network
package): `describeDataPart` renders a valid OIP/1 data part on an A2A message into one
paragraph for the model, and `promptExtraFor(principal, channel)` adds `networkGuidance`
for the principal to the system prompt. Both are exported for embedders that build their
own `AgentRuntime`.

Also exported: `ConsoleOutbox`, `ChatAwareOutbox`, `ChatReplyBuffer`, `fileTools` (below),
`createScheduleSync` (the Maritime schedule push), `loadSkillsPrompt`,
`ensureWebhookSubscription`, `paymentsEnv`, `loadPaymentsModule`, `apiKeyFor`.

### File tools

`fileTools(workspace, { bash?, env? })` registers Pi's `read`, `ls`, `grep`, `write`, `edit`
and `bash` with `files.read` / `files.write` capabilities (owner only by default).

- `read`, `ls`, `grep`, `write` and `edit` refuse any `path` that resolves outside
  `<data>/workspace` after following symlinks (absolute paths, `..`, `~`, and links that
  point out of the workspace all return an `isError` result). Pi's own resolver would
  accept absolute paths, which is how `/data/secrets/webhook.json` or another principal's
  session transcript could otherwise be read from the owner conversation.
- `bash` is a real shell with cwd = workspace, not a sandbox. It runs with a small
  allowlisted environment (`PATH`, `HOME`, `LANG`, `LC_*`, `TZ`, `TERM`, `TMPDIR`, ...;
  see `SHELL_ENV_ALLOWLIST`) and nothing whose name matches `KEY`, `SECRET`, `TOKEN`,
  `PASSWORD` or `CREDENTIAL`, so `env` inside the shell never shows a provider or Inkbox
  key. It can still read any file the process user can read, which is why the image runs
  as an unprivileged user and why these tools are visible to the owner tier only.

## Running locally

```bash
pnpm -r build
INSTINCT_OWNER_PHONE=+15551234567 ANTHROPIC_API_KEY=... INSTINCT_CHAT_TOKEN=$(openssl rand -hex 24) node packages/server/dist/main.js
curl -s 127.0.0.1:8080/chat -H "authorization: Bearer $INSTINCT_CHAT_TOKEN" -H 'content-type: application/json' -d '{"message":"hi"}'
```

Without `PORT` the server listens on `127.0.0.1:8080`; the token is optional on loopback
but cheap to set. With an Inkbox identity, add `INKBOX_API_KEY`, `INKBOX_AGENT_HANDLE` and
`INSTINCT_TUNNEL=1`. The server prints the tunnel URL (it serves webhooks only) and, when
`INKBOX_ADMIN_API_KEY` is set, subscribes `imessage.received`, `text.received`,
`message.received` and the A2A events to `<url>/webhooks/inkbox`. The signing key is
stored in `<data>/secrets/webhook.json` (mode 0600).

## Smoke test

`pnpm --filter @open-instinct/server build && pnpm smoke` boots a real agent in a
temp directory with Pi's faux provider (no network, no keys) and checks:

1. Owner chat: "remember that I like window seats" makes the model call `memory_write`;
   `MEMORY.md` contains the text and `/chat` returns the final answer.
2. Stranger iMessage (relayed as an envelope): the model tries `memory_write`, the tool
   is not available to a stranger, the write does not land, and exactly one iMessage
   reply goes out through the outbox for `imessage:<conversation_id>`.
3. `GET /schedules` is `[]`, then a `schedule_create` call makes it non-empty.
4. A stranger's agent sends an A2A task (with an OIP/1 `ask` part) for the owner's calendar.
   The caller resolves to `stranger:a2a:<handle>`, `memory_read` is not available to it, the
   only allowed tool call is `notify_owner`, the owner gets exactly one iMessage through the
   outbox, exactly one A2A reply completes the task with the inbound `replyRef`, and nothing
   from `MEMORY.md` appears in either message.

It exits non-zero on any failed check.

## Tests

`pnpm --filter @open-instinct/server test` runs vitest against a stubbed runtime: every
route (health, status, schedules, owner chat, envelope chat, body limit, 400/404/500,
webhook 503/401/204), the chat token (401 without it, Bearer and header forms, envelope
rejection), the webhook-only tunnel listener (404 for the owner's surface), schedule wakes
(run once on `scheduled:<id>`, never as owner chat, acked when already run), pending chat
replies, the Link callback route and envelope, the bind-address rule, the Maritime schedule
sync, the console outbox, the file tool guards (paths outside the workspace, symlinks, the
scrubbed shell environment), the payments loader, the webhook subscription setup and the
skills loader.

## Docker

`deploy/Dockerfile.agent` builds this package into `ghcr.io/<owner>/open-instinct-agent`.
The image sets no `PORT` (Maritime injects 18789; compose sets 8080), runs the server as
the unprivileged `instinct` user through `deploy/entrypoint.sh` (which fixes `/data`
ownership and drops privileges with `setpriv`), and health-checks `${PORT:-8080}`.
`deploy/docker-compose.yml` runs it next to the gateway for a local trial, publishing the
agent on `127.0.0.1:8080` only.

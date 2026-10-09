# Open Instinct: architecture

Open Instinct is an open-source personal agent you text. Like Instinct, it has its
own computer, does real tasks for you, and can coordinate with the Instincts of
people you trust. Unlike Instinct, you can read every line, run it yourself, pick
the model, and see exactly what each person in your life is allowed to ask it.

This document is the build contract. Every package below implements one box in
the diagram and nothing else.

(Open Instinct is unrelated to OpenInstinct, a separate project published by Merit Systems.)

## Table of contents

1. [The idea in one picture](#the-idea-in-one-picture)
2. [Building blocks](#building-blocks)
3. [Repository layout](#repository-layout)
4. [Runtime model](#runtime-model)
5. [Message flow](#message-flow)
6. [State on disk](#state-on-disk)
7. [Tools](#tools)
8. [Trust and permissions](#trust-and-permissions)
9. [Agent to agent](#agent-to-agent)
10. [Payments](#payments)
11. [Deployment shapes](#deployment-shapes)
12. [Configuration](#configuration)
13. [Safety rules](#safety-rules)
14. [Testing](#testing)
15. [Decisions and alternatives](#decisions-and-alternatives)

## The idea in one picture

```
  you (iMessage / SMS / email)        a friend's Instinct
            │                                 │  A2A (JSON-RPC over Inkbox)
            ▼                                 ▼
   ┌────────────────── Inkbox ─────────────────────┐   phone number, email,
   │ identity @maria  · iMessage · SMS · mail · A2A │   iMessage line, webhooks
   └───────────────────────┬───────────────────────┘
                           │ signed webhooks
                           ▼
   ┌──────────────── gateway (stateless relay) ─────┐  one per deployment,
   │ verify signature → find the user's agent →     │  many users
   │ wake it through Maritime → forward the event   │
   └───────────────────────┬────────────────────────┘
                           │ POST /chat (Maritime wakes the microVM)
                           ▼
   ┌──────────────── the agent (one per user) ──────────────────────────────┐
   │ server (/health /chat /schedules /webhooks/inkbox /oauth/link/callback) │
   │   └ core: Pi agent loop · policy engine · memory · scheduler · audit    │
   │        ├ computer: this VM's Linux desktop (Chromium, LibreOffice)      │
   │        ├ apps: Gmail, Calendar, … through Composio (MCP)                │
   │        ├ payments: Stripe Link agent wallet, one-time cards             │
   │        ├ inkbox: send iMessage / SMS / email, typing, tapbacks          │
   │        └ network: contacts, trust tiers, invitations, A2A worker/caller │
   └─────────────────────────────────────────────────────────────────────────┘
```

Analogy: Inkbox is the phone company. Maritime is the apartment the agent lives
in, with a desk and a computer. Composio is the keyring to your online accounts.
Link is the wallet you keep, from which the agent asks for exact change. Pi is the
agent's brain stem.

## Building blocks

| Block | What we use | Why |
|---|---|---|
| Agent loop | `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` (Pi, by Mario Zechner, now at Earendil) | Minimal, typed, tool hooks (`beforeToolCall`), steering and follow-ups, 40+ providers. Pi is the framework OpenClaw was originally built on. OpenClaw now ships its own `@openclaw/agent-core` and keeps only `pi-tui`; see [research/TECH-REFERENCE.md](research/TECH-REFERENCE.md), section 1.11 |
| Sessions, compaction, skills, file tools | `@earendil-works/pi-coding-agent` | The same SKILL.md convention Pi, OpenClaw and Claude Code read; `read`, `write`, `edit`, `bash`, `ls`, `grep` factories |
| MCP client | `@earendil-works/pi-mcp` | Stdio and Streamable HTTP, no SDK dependency, `toLlmContent()` helper |
| Phone, iMessage, email, agent identity | Inkbox (`@inkbox/sdk`) | One identity = handle + mailbox + optional phone + iMessage + A2A endpoint + webhooks |
| Computer | Maritime desktop (`desktop: true` on the agent, `desktopd` on 127.0.0.1:5911 inside the VM) or hosted Maritime Computers MCP (`https://mcp.maritime.sh/mcp/u/{user}`) | Persistent Linux desktop per user, screenshot/click/type, human takeover for logins and payments |
| Hosting | Maritime (`maritime-sdk`): one Firecracker microVM per user, sleeps when idle, wakes on message, `/data` persists, scheduled wakes | The "agent has its own computer" part without running servers |
| Apps | Composio Tool Router (`@composio/core`): one session per user, exposed as an MCP URL | Gmail, Google Calendar, Contacts, Slack, Notion and 1000+ toolkits with per-user OAuth |
| Payments | Stripe Link Agent Wallet (`@stripe/link-sdk`): OAuth with PKCE, spend requests, one-time cards | The owner approves each amount and merchant in Link; the agent never holds a card on file |
| Models | Pi model catalog. Default `anthropic/claude-fable-5-1` | Any Pi provider works, including OpenAI-compatible proxies (`openai-compatible/<id>` with `OPENAI_BASE_URL`) |

## Repository layout

```
open-instinct/
  README.md                     start here
  CONTRIBUTING.md
  docs/                         this file, PERMISSIONS.md, PROTOCOL.md, BUILD-BRIEF.md, research/
  packages/
    core/      @open-instinct/core      agent runtime: Pi loop, prompt builder, policy engine, approvals, memory, scheduler, audit, types
    inkbox/    @open-instinct/inkbox    Inkbox adapter: provision identity, send iMessage/SMS/email, parse+verify webhooks, A2A REST and JSON-RPC
    computer/  @open-instinct/computer  desktop tools: in-VM desktopd (REST) or hosted Computers MCP (HTTP)
    apps/      @open-instinct/apps      Composio Tool Router: per-user session, MCP tools, connect links
    network/   @open-instinct/network   trusted network: contacts, tiers, grants, invitations, OIP envelope, A2A tools
    payments/  @open-instinct/payments  Stripe Link agent wallet: OAuth, spend requests, one-time cards, payment_* tools
    ample/     @open-instinct/ample     web app deploys through the Ample CLI: ample_deploy, ample_logs, ample_apps, ample_app_delete
    server/    @open-instinct/server    the agent process: /health, /chat, /schedules, webhook intake, Link callback, smoke test
    gateway/   @open-instinct/gateway   multi-user relay + signup: Inkbox webhooks → Maritime agent; connect page with QR
    cli/       @open-instinct/cli       `instinct` command: init, connect, dev, chat, status, deploy, invite, trust, schedules, payments
  skills/      SKILL.md playbooks the agent loads (onboarding, scheduling, dining, travel, rides, email-triage, research, purchases, files, daily-brief, trusted-network, maritime-computer, web-apps)
  examples/    local-chat.mjs, fake-inkbox-webhook.mjs, dinner-a2a.mjs (see examples/README.md)
  deploy/      Dockerfile.agent, Dockerfile.gateway, docker-compose.yml, entrypoint.sh, .env.example
  .github/workflows/build-images.yml   builds and pushes both images to GHCR
```

Package rules:

- TypeScript, ESM, Node 22.19+ (Pi requires it). `pnpm` workspaces. Strict mode.
- `core` depends on Pi only. `inkbox`, `computer`, `apps`, `network` and `payments` depend on `core` for types. `server` wires them. `gateway` and `cli` depend on `maritime-sdk` and `@inkbox/sdk`.
- Every package exports from `src/index.ts`, ships `dist/` built by `tsc`, and has vitest tests in `test/`.
- No package reads `process.env` except `server`, `gateway` and `cli` (through `core`'s `loadConfig`). Libraries take options.

## Runtime model

One agent process serves one person (the **owner**). Inside it:

- **Conversations.** Every thread gets its own Pi `Agent` and JSONL session under `sessions/`. Keys:
  `imessage:<conversation_id>`, `sms:<e164>`, `email:<thread_id>`, `a2a:<context_id>`,
  `chat:<conversation_id>` (Maritime dashboard, CLI), `scheduled:<job_id>`. In an iMessage group
  each participant gets a key of their own (`imessage:<conversation_id>:<principal id>`) so a
  stranger in the group never sees the owner's context.
- **Principal.** Each inbound event is resolved to a principal before the model sees it:
  `{ kind: "owner" | "contact" | "agent" | "stranger", id, tier, displayName, ... }`.
  Resolution order: owner identifiers in config → contacts.json (phone, email, agent handle) → A2A caller handle → stranger.
- **Policy.** The principal's tier picks the tool set and the capability grants (see
  [PERMISSIONS.md](PERMISSIONS.md)). The policy engine runs twice: once to choose which
  tools the model can even see, and once in `beforeToolCall` to block anything that slipped
  through. Spend limits and "ask the owner first" live here. A refusal of a non-owner's request
  is also reported to the owner (see [Trust and permissions](#trust-and-permissions)).
- **Prompt.** `persona + owner profile + principal card + capabilities + memory digest + skills index + channel etiquette`.
  Non-owner content is wrapped as untrusted data.
- **Long work.** `/chat` must answer in under 30 seconds (Maritime budget). The server waits up to
  `INSTINCT_REPLY_BUDGET_MS` (default 20 s), then acknowledges, keeps the Pi run going, and delivers
  the result through the channel (Inkbox send) when done. The owner can steer mid-task; new messages
  in the same conversation become `steer()` on the running agent.
- **Proactive.** `schedules.json` holds cron or one-shot jobs with a prompt. The server exposes
  `GET /schedules` and pushes the list to Maritime so a sleeping VM is woken; when awake, an
  in-process timer fires them too. Each run is a prompt on `scheduled:<job_id>` as the owner,
  with the result texted to the owner.
- **Memory.** `memory/MEMORY.md` (durable facts, preferences, people), `memory/journal/YYYY-MM-DD.md`
  (what happened), `contacts.json` (people and tiers). `memory_write` appends; the prompt builder
  injects a digest. Older turns are folded into a summary to keep sessions small.
- **Audit.** Every tool call, policy decision, outbound message and spend lands in
  `audit.jsonl`. The owner can ask "what did you do today" (`audit_read`).

## Message flow

Inbound iMessage from the owner, through the gateway:

1. The owner texts the agent's line. Inkbox posts `imessage.received` to the gateway URL
   with `X-Inkbox-Signature`, `X-Inkbox-Timestamp`, `X-Inkbox-Request-ID`.
2. The gateway verifies HMAC-SHA256 over `{request_id}.{timestamp}.{raw_body}` with that
   identity's signing key, maps identity → user → Maritime agent id, and calls
   `POST https://api.maritime.sh/api/agents/{id}/chat` with
   `{ message: "@@instinct-event@@" + JSON(event), conversation_id: <inkbox conversation_id> }`.
   Maritime wakes the microVM (about 1 s) and delivers to the agent's `POST /chat`.
3. The server unwraps the envelope, resolves the principal (owner), sends a typing
   indicator, and prompts the owner conversation.
4. The agent works (tools, computer, apps). It replies through the Inkbox outbox on the same
   conversation. The `/chat` HTTP response is empty; the reply travels over iMessage.

Self-hosted without the gateway: `instinct dev --tunnel` (or `INSTINCT_TUNNEL=1` on the server)
opens an Inkbox tunnel to a second, loopback-only listener that serves `GET /health` and
`POST /webhooks/inkbox` and nothing else, and subscribes the webhooks to it when
`INKBOX_ADMIN_API_KEY` is present. Same handler, no relay. `/chat` is never reachable through the tunnel.

Plain `/chat` without the envelope (dashboard, CLI, `instinct chat`) is treated as the owner
speaking on `chat:<conversation_id>` and the reply goes back in the HTTP response. Replies the
agent finishes after an earlier acknowledgement come back as `pending` on the next call.

## State on disk

`$INSTINCT_DATA_DIR` (Maritime: `/data`; local: `./.instinct`):

```
config.json              owner identity (phones, emails, name, timezone), model, computer mode, apps
policy.json              trust tier overrides, grants, spend limits, stranger limits
contacts.json            people: name, phones, emails, agent handle, tier, notes
memory/MEMORY.md         durable memory (markdown, human-editable)
memory/journal/          one file per day
sessions/                Pi JSONL sessions, one per conversation key
schedules.json           scheduled jobs (served on GET /schedules, pushed to Maritime)
approvals.json           pending owner approvals (token, action, expiry); approvals-context.json, approved.json
audit.jsonl              append-only audit log
owner-notices.json       when the owner was last told about a refused request, per conversation
conversations.json       which principal and reply address each conversation key belongs to
seen-ids.json            webhook event ids already handled (replay protection)
strangers.json           stranger rate-limit counters
pending-replies.json     chat replies finished after the HTTP response was sent
apps.json                the Composio session id and toolkits
payments.json            spend requests (ids, amounts, merchants, status); never card data
secrets/                 mode 0600: webhook.json (signing key), inkbox.json (CLI), link-oauth.json, link-tokens.json
workspace/               files the agent creates for the owner (the file tools are scoped here)
inbox/                   files the owner sent
```

## Tools

All tools are Pi `AgentTool`s (TypeBox schema + `execute`) registered with capability tags that the
policy engine checks. Groups:

| Group | Tools | Source | Present when |
|---|---|---|---|
| messaging | `send_message` (reply on the current channel or to a contact: iMessage, SMS, email), `send_typing`, `react`, `send_file` (a workspace file as an attachment: iMessage and SMS up to 10 MB through the Inkbox media upload, email up to 25 MB; in the dashboard chat it returns a `maritime-file` block the dashboard renders as an attachment) | `@open-instinct/inkbox` | `INKBOX_API_KEY` and a handle are set; `send_file` is always present, chat-only without Inkbox |
| owner | `ask_owner` (approval or question, with token), `notify_owner`, `audit_read` | `core` | always |
| memory | `memory_read`, `memory_write`, `journal_append` | `core` | always |
| schedule | `schedule_create`, `schedule_list`, `schedule_delete` | `core` | always |
| web | `web_search`, `web_fetch` (public hosts only, no login) | `core` | always |
| files | `read`, `write`, `edit`, `bash`, `ls`, `grep`, scoped to `workspace/` | `pi-coding-agent` factories wrapped by `server` | always, owner only |
| files | `create_pdf` (markdown to a real PDF under `workspace/`: headings, lists, tables, code, links, page numbers) | `core` | always, owner only |
| contacts and trust | `contacts_search`, `contacts_upsert`, `trust_set_tier`, `trust_grant`, `trust_revoke`, `trust_list` | `@open-instinct/network` | always |
| network | `ask_instinct` (one contact, or several for a group plan), `reply_instinct`, `invite_to_network` | `@open-instinct/network` | always; A2A sends need Inkbox, invitations need `INKBOX_ADMIN_API_KEY` |
| computer (in the VM) | `computer`, `computer_batch`, `request_takeover`, `takeover_status`, `computer_read_file`, `computer_write_file` | `@open-instinct/computer` over desktopd REST | `INSTINCT_COMPUTER` is `auto` or `desktopd` and desktopd answers |
| computer (hosted) | the server's own names: `get_computer`, `computer`, `computer_batch`, `run_shell`, `read_file`, `write_file`, `request_takeover`, `takeover_status`, `close_computer` | `@open-instinct/computer` over MCP | `MARITIME_API_KEY` and no in-VM desktop |
| apps | one `app_<slug>` tool per Composio tool (for example `app_googlecalendar_events_list`) | `@open-instinct/apps` over MCP | `COMPOSIO_API_KEY` is set |
| files | `ample_deploy` (a workspace folder to a public URL), `ample_logs`, `ample_apps`, `ample_app_delete` | `@open-instinct/ample`, driving the `ample` CLI | `AMPLE_SIGNUP=1`, or `AMPLE_CLIENT_ID` and `AMPLE_CLIENT_SECRET` (or `AMPLE_TOKEN`) are set; owner only |
| payments | `payment_connect`, `payment_request`, `payment_status`, `payment_list` | `@open-instinct/payments` | `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET` and `STRIPE_PUBLISHABLE_KEY` are set |

MCP results are converted with `pi-mcp`'s `toLlmContent()`. Composio tool names get the `app_` prefix
and are clipped to 64 characters. Computer tool names are the backend's own, so prompts written for
Maritime's documentation work unchanged.

## Trust and permissions

Six tiers: `owner`, `partner`, `family`, `friend`, `contact`, `stranger`. Each tier has default
capabilities; the owner adds scoped, time-boxed grants ("Sam can book us dinner this week").
Anything not granted is denied. Purchases and calendar writes by non-owners default to
"ask the owner", which sends the owner a one-line approval text.

The guard is enforced twice. When the policy denies a request from anyone but the owner, the
requester gets a polite refusal and the owner gets a text: "Sam's agent (@sam-instinct) asked to
read your calendar; I declined." One notice per conversation per hour (`owner-notices.json`), and
the notice is itself audited. For "ask" outcomes the approval text is the notice. Full table, grant
grammar and approval rules: [PERMISSIONS.md](PERMISSIONS.md).

## Agent to agent

Two Instincts talk through Inkbox A2A (A2A 1.0, JSON-RPC at `https://inkbox.ai/a2a/{handle}`).
Our agent is both a **worker** (Inkbox hosts the inbox; `a2a.task.created` webhooks wake us; we
answer with `POST /api/v1/identities/{handle}/a2a/tasks/{id}/reply`) and a **caller**
(`InkboxA2A.send(peer, text, data, { contextId })` posts `SendMessage`; the peer's progress arrives
as `a2a.sent_task.updated` webhooks). Messages carry plain text for any model plus an `OIP/1` data
part with a typed intent (`propose_times`, `request_freebusy`, `accept`, `decline`, `confirm`, `ask`,
`inform`, `share`, `book_request`). Admission is double-gated: Inkbox contact rules (who may call at
all) and our tiers (what they may ask).

Group plans fan out: `ask_instinct` with `contacts: [...]` sends the same intent to every person.
Each Instinct gets its own task and answers in its own `a2a:<context_id>` conversation; people without
an Instinct get the same request as a text or email (owner only). The model combines the answers for
the owner. Spec: [PROTOCOL.md](PROTOCOL.md). A runnable two-agent dinner with a stubbed transport is
in [examples/dinner-a2a.mjs](../examples/dinner-a2a.mjs).

## Payments

Instinct's rail is Stripe Link. Ours is too. With the Link OAuth client configured, the owner connects
their Link account once (`payment_connect` texts a `login.link.com` link; the callback lands on
`GET /oauth/link/callback`, or on the gateway, which relays it as a `link.oauth_callback` envelope).
For a purchase, the model gets the checkout to a final total and calls `payment_request` with the exact
amount and merchant. Core's spend policy runs first (`purchase` capability, ask above $50 by default).
Link shows the owner an approval screen; after approval, `payment_status` returns a one-time card
exactly once, the agent types it into the checkout on its desktop, and a `spend` audit entry records the
amount. Card data never lands in `payments.json`, the audit log, the journal or any message. Details:
[packages/payments/README.md](../packages/payments/README.md).

## Deployment shapes

1. **Maritime, many users (the Instinct shape).** `gateway` runs once (Railway, Fly, or as an
   always-on Maritime agent with `publicWeb`). Each signup provisions an Inkbox identity
   (`imessage_enabled: true`) and a Maritime agent from `deploy/Dockerfile.agent` with
   `framework: "custom"`, `desktop: true`, `externalId: <userId>`, env `INKBOX_*`,
   `ANTHROPIC_API_KEY`, `COMPOSIO_API_KEY`, `LINK_*`. Users text `connect @handle` to the Inkbox
   router number (or scan the QR) and are talking to their agent. Guide: [packages/gateway/README.md](../packages/gateway/README.md).
2. **Maritime, one user.** `instinct deploy --image ...` does the same for you alone; no gateway.
   Inkbox webhooks reach the agent through a gateway you run yourself, or, once Maritime
   supports Inkbox's signature scheme natively, through a Maritime signed-webhook address.
   Guide: [packages/cli/README.md](../packages/cli/README.md).
3. **Self-hosted.** `instinct dev --tunnel` runs the server on your machine, opens the Inkbox
   tunnel for webhooks, and uses the hosted Computers MCP (or no computer).

The BYO contract the image must satisfy: bind `0.0.0.0:$PORT`, `GET /health` → 200,
`POST /chat` → `{response}` within 30 s, state under `/data`, `python3` on PATH, optional
`GET /schedules`.

## Configuration

Only `server`, `gateway` and `cli` read `process.env`. `config.json` wins over env after first
boot; env seeds it. The annotated list is [deploy/.env.example](../deploy/.env.example).

What the model is told is five files, not env: `PERSONA.md` (voice), `AGENTS.md` (standing
instructions), `skills/`, `memory/MEMORY.md` and `policy.json`. `instinct prompt --layers`
shows each section of the system prompt with the file that decides it; [CUSTOMIZE.md](CUSTOMIZE.md)
says how to change each one.

Server:

| Variable | Meaning |
|---|---|
| `INSTINCT_DATA_DIR` | state directory (default `/data` if it exists, else `./.instinct`) |
| `INSTINCT_MODEL` | `provider/model`, default `anthropic/claude-fable-5-1`; `openai-compatible/<id>` uses `OPENAI_BASE_URL` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, ... | model access, looked up per Pi provider |
| `INSTINCT_OWNER_NAME`, `INSTINCT_OWNER_PHONE`, `INSTINCT_OWNER_EMAIL`, `INSTINCT_OWNER_TIMEZONE`, `INSTINCT_AGENT_NAME` | who the owner is and what the agent is called; seeded into `config.json` on first boot |
| `INSTINCT_PERSONA` | seeds `<data>/PERSONA.md` on first boot only; after that the file is the owner's (`instinct persona`) |
| `INKBOX_API_KEY`, `INKBOX_AGENT_HANDLE`, `INKBOX_IDENTITY_ID` | identity-scoped Inkbox credentials; turn on the Inkbox outbox, messaging tools and A2A |
| `INKBOX_SIGNING_KEY` | webhook signing key (also read from `secrets/webhook.json`) |
| `INKBOX_ADMIN_API_KEY` | org-wide key: invitations, contact rules, webhook subscription with the tunnel |
| `INSTINCT_TUNNEL` | `1` opens an Inkbox tunnel to the webhook-only listener |
| `INSTINCT_CHAT_TOKEN` | bearer token for `/chat`, `/status`, `/schedules` |
| `INSTINCT_BIND` | bind address; default `127.0.0.1`, or `0.0.0.0` when `PORT` or a `MARITIME_*` variable is set |
| `INSTINCT_PUBLIC_URL` | this agent's public URL, used to build the Link callback |
| `INSTINCT_REPLY_BUDGET_MS` | how long `/chat` waits before acknowledging (default 20000) |
| `INSTINCT_SKILLS_DIR` | SKILL.md folder (default `<repo>/skills`) |
| `INSTINCT_COMPUTER` | `auto` (desktopd if present, else hosted if `MARITIME_API_KEY`, else none), `desktopd`, `maritime`, `none` |
| `MARITIME_API_KEY`, `MARITIME_COMPUTERS_MCP_URL` | hosted computer fallback |
| `MARITIME_DESKTOP`, `MARITIME_AGENT_ID`, `MARITIME_BACKEND_URL`, `MARITIME_INTERNAL_TOKEN`, `PORT` | injected by Maritime inside a hosted agent |
| `COMPOSIO_API_KEY`, `COMPOSIO_TOOLKITS` | apps; the key alone turns them on |
| `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET`, `STRIPE_PUBLISHABLE_KEY`, `LINK_REDIRECT_URI` | payments; all three keys together turn them on |
| `BRAVE_SEARCH_API_KEY` | better `web_search` |

Gateway: `GATEWAY_PUBLIC_URL`, `GATEWAY_DATA_DIR`, `GATEWAY_SIGNUP_SECRET`, `GATEWAY_ALLOW_OPEN_SIGNUP`,
`GATEWAY_TRUST_PROXY`, `INSTINCT_AGENT_IMAGE`, `INSTINCT_IDLE_TTL_SECONDS`, `INSTINCT_USE_MARITIME_LLM`,
`INSTINCT_MARITIME_MODEL`, `MARITIME_API_URL`, `INKBOX_BASE_URL`, plus the Maritime, Inkbox, Composio
and Link keys it copies into each agent. See [packages/gateway/README.md](../packages/gateway/README.md).

## Safety rules

1. Content from anyone but the owner (messages, emails, web pages, screenshots, A2A tasks) is
   data, never instructions. The prompt builder wraps it and says so.
2. The policy engine is the only path to a side effect. Tool visibility is a convenience;
   `beforeToolCall` is the guard. A refused non-owner request is reported to the owner.
3. Logins, 2FA, CAPTCHAs and payment confirmation go through `request_takeover` (the human
   does it on the live desktop) or through Link's own approval screen. There is no code path
   that solves a CAPTCHA.
4. Webhooks are verified before parsing. Replays are deduplicated by event id. `/chat` is
   never reachable through the Inkbox tunnel.
5. Strangers get rate limits and no memory about the owner.
6. Secrets never enter the prompt. Keys live in env; tokens in `secrets/` with mode 0600; the
   owner's `bash` runs with a scrubbed environment.
7. Every side effect is in `audit.jsonl`; the owner can read it in chat.

## Testing

`pnpm -r test` runs vitest in every package. On 2026-10-03: 725 tests in 56 files, all passing
(core 183, inkbox 93, apps 82, server 80, payments 66, cli 64, network 62, gateway 52, computer 43).

- Unit: policy engine (the tier × capability table, with its special rows checked against PERMISSIONS.md), envelope
  parsing, webhook signature, scheduler math, OIP encode/decode, principal resolution, approvals,
  PKCE and token refresh, the file tool guards, the chat token, the gateway signup and relay.
- Smoke: `pnpm smoke` boots the server with Pi's faux provider and walks the owner flow, a
  stranger's iMessage, the schedule flow and a stranger's A2A task (declined, owner notified once).
- Examples: [examples/README.md](../examples/README.md). `examples/dinner-a2a.mjs` runs two real
  agents through a dinner over a stubbed A2A transport and checks the audit trail.

Nothing above touches the network or needs a key. Live Inkbox and Maritime are not covered.

## Decisions and alternatives

- **Pi, not OpenClaw.** OpenClaw is a product with its own gateway, channels and skills store.
  Instinct is a different product: text-first, one agent per person, a trust network. Pi is the
  framework OpenClaw was first built on, and it is still published as a standalone library, so
  we get the same loop without the rest. That OpenClaw has since moved its loop in-house does
  not change what we need from Pi.
- **Gateway relay instead of a tunnel per agent.** Maritime agents sleep; a tunnel would die
  with them. The front-door call wakes the VM and the agent answers by sending outbound through
  Inkbox. One stateless relay serves every user.
- **MCP for the outside world, REST where it is simpler.** Composio and the hosted desktop arrive
  through `pi-mcp`. The in-VM desktop is driven over desktopd's REST API, which removes a
  subprocess and lets `request_takeover` return without blocking.
- **Policy in code, not in the prompt.** Prompts leak. The tier table is JSON and the guard is a
  function with tests.
- **Link, not a card on file.** The agent asks for exact change per purchase and the owner approves
  in Link. No card number ever sits in the agent's state.

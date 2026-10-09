# Deploying Open Instinct on Maritime

This is the Instinct-shaped deployment. Each person gets their own agent in its own microVM, with a Linux desktop the agent can click on. The VM sleeps when nobody is talking to it and wakes when a message arrives.

Open Instinct is unrelated to OpenInstinct, a separate project published by Merit Systems.

Read [ARCHITECTURE.md](ARCHITECTURE.md) first if you are new to the project. The other deployment shapes (laptop with `instinct dev`, local Docker) are covered in [../packages/cli/README.md](../packages/cli/README.md) and [../deploy/docker-compose.yml](../deploy/docker-compose.yml).

## Contents

- [What you get](#what-you-get)
- [Prerequisites](#prerequisites)
- [Build and publish the image](#build-and-publish-the-image)
- [One user: `instinct deploy`](#one-user-instinct-deploy)
- [Many users: the gateway](#many-users-the-gateway)
- [How inbound reaches a sleeping agent](#how-inbound-reaches-a-sleeping-agent)
- [Costs and limits](#costs-and-limits)
- [Troubleshooting](#troubleshooting)

## What you get

| Piece | What it is |
|---|---|
| One microVM per person | Maritime runs a Firecracker microVM for each agent. The agent's files, memory and secrets live under `/data` in that VM. Nothing is shared between people. |
| A desktop | The agent is created with `desktop: true`. Inside the VM, `desktopd` gives the agent a screen, a mouse and a keyboard. The agent uses it to browse, book and fill forms. |
| Sleep and wake | When the agent has been idle for `idleTtlSeconds`, Maritime snapshots the VM. A message, a webhook or a schedule wakes it in about one to three seconds. You pay for awake time, not for the hours in between. |
| The BYO contract | The image follows Maritime's bring-your-own rules: bind `0.0.0.0:$PORT`, `GET /health`, `POST /chat`, state under `/data`, `python3` on PATH, optional `GET /schedules`. See [../packages/server/README.md](../packages/server/README.md). |

An analogy: the VM is a desk that folds into the wall when nobody is sitting at it. The desk, the papers on it and the computer come back exactly as they were.

## Prerequisites

| Need | Why | Where to get it |
|---|---|---|
| Maritime account and an `mk_` key | Creates agents, relays chat, sets secrets | Maritime dashboard, API keys. Give the key the `provision`, `deploy` and `secrets` scopes, or `manage`. Set it as `MARITIME_API_KEY`. |
| Inkbox org admin key | Provisions the agent's iMessage identity, mints its scoped key, subscribes webhooks | Inkbox dashboard. Set it as `INKBOX_ADMIN_API_KEY`. The gateway needs it for signup. A single user needs it once, for `instinct init`. |
| Anthropic key | The model | Set it as `ANTHROPIC_API_KEY`. It is copied into each agent as a secret. Without a key of your own, use Maritime's metered proxy (`--maritime-llm`, or `INSTINCT_USE_MARITIME_LLM=1` on the gateway). |
| Composio key (optional) | Gmail, Calendar, Contacts | Set `COMPOSIO_API_KEY`. `COMPOSIO_TOOLKITS` picks the toolkits; default `gmail,googlecalendar,googlecontacts`. |
| Stripe Link (optional) | A wallet the agent can pay from, one-time cards per approved amount | Set `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET` and `STRIPE_PUBLISHABLE_KEY`. All three are required for payment tools to appear. |
| A container registry | Maritime pulls the agent image from it | GitHub Container Registry (`ghcr.io`) through the included workflow. |

A note on the Maritime key. If an agent will also use the hosted Computers MCP instead of the in-VM desktop, the same key must also carry `computers`. A key with only `computers` is refused by the agents API, so a deployment that needs both uses `manage` or `*`.

## Build and publish the image

The repository ships a GitHub Actions workflow, [.github/workflows/build-images.yml](../.github/workflows/build-images.yml). It builds two images and pushes them to GHCR:

| Image | Dockerfile | Used by |
|---|---|---|
| `ghcr.io/<owner>/open-instinct-agent` | `deploy/Dockerfile.agent` | Maritime, one container per person |
| `ghcr.io/<owner>/open-instinct-gateway` | `deploy/Dockerfile.gateway` | Railway or any host that runs the relay |

`<owner>` is your GitHub user or org, lowercased. The workflow runs on every push to `main`, on tags that start with `v`, and by hand through `workflow_dispatch`. It builds for `linux/amd64` and `linux/arm64`.

Tags it writes:

| Push | Tags |
|---|---|
| `main` | `main`, `latest`, `sha-<short sha>` |
| `v1.2.3` | `1.2.3`, `1.2`, `sha-<short sha>` |

Steps:

1. Fork or push the repository to GitHub.
2. Push to `main`, or create a tag such as `v0.1.0`.
3. Wait for the `build-images` workflow to finish.
4. In the GitHub package settings, make `open-instinct-agent` public, or give Maritime a pull token. Maritime pulls the image when it creates the agent.

To build locally for a trial, use Docker Compose. It does not publish anything.

```bash
cp deploy/.env.example deploy/.env   # fill it in
docker compose -f deploy/docker-compose.yml up --build
```

The agent image sets no `PORT`. Maritime injects `PORT=18789`. Docker Compose sets `PORT=8080`. The server binds whatever it is given. Do not set `PORT=8080` inside a Maritime VM; that port is reserved there.

## One user: `instinct deploy`

This creates one agent for you. No gateway. The steps mirror the example session in [../packages/cli/README.md](../packages/cli/README.md).

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22.20.0
pnpm install && pnpm -r build
cd packages/cli && pnpm link --global && cd ../..

export INKBOX_ADMIN_API_KEY=ik_admin_...
export ANTHROPIC_API_KEY=sk-ant-...
export MARITIME_API_KEY=mk_...

# 1. Config and the iMessage identity. Secrets land in <dataDir>/secrets/inkbox.json.
instinct init --name "Maria" --phone +14155550100 --email maria@example.com \
  --handle maria-instinct --timezone America/New_York

# 2. Create the Maritime agent from the published image.
instinct deploy --image ghcr.io/<owner>/open-instinct-agent:latest

# 3. Talk to it through Maritime. This wakes the VM.
instinct chat "hello" --agent agt_...
```

What `deploy` sends: `framework: "custom"`, `exposedPort: 18789`, `healthCheckPath: "/health"`, `desktop: true`, `externalId: "open-instinct:<handle>"`, `idleTtlSeconds` (default 900), and the env vars the agent needs. `INKBOX_*` come from `secrets/inkbox.json`. `ANTHROPIC_API_KEY`, `COMPOSIO_*`, `BRAVE_SEARCH_API_KEY` and the `LINK_*` set come from your shell. Secrets are flagged `isSecret` so Maritime encrypts them. The agent id is saved to `<dataDir>/maritime.json`.

Flags you may want:

| Flag | Use |
|---|---|
| `--idle <seconds>` | How long the VM stays awake with no traffic. Default 900. |
| `--no-desktop` | No Linux desktop. Cheaper. The agent falls back to the hosted Computers MCP if `MARITIME_API_KEY` is in its env, else it has no computer. |
| `--maritime-llm` | No model key of your own. Maritime injects its metered proxy and `INSTINCT_MODEL` becomes `openai-compatible/<model>`. |
| `--model <id>` | The proxy model with `--maritime-llm` (default `gpt-5.4`, or `INSTINCT_MARITIME_MODEL`). |
| `--dry-run` | Print the request body with secrets redacted. Create nothing. |

After `deploy`, iMessage does not reach the agent yet. Inkbox must be told where to post webhooks. Two options are in [How inbound reaches a sleeping agent](#how-inbound-reaches-a-sleeping-agent). The CLI prints both.

## Many users: the gateway

The gateway is one small always-on service. People sign up on it, it provisions an agent for each of them, and it relays Inkbox webhooks to the right agent. It holds no conversation state and never sees the model. Full reference: [../packages/gateway/README.md](../packages/gateway/README.md).

```
person's iPhone ──iMessage──▶ Inkbox ──signed webhook──▶ gateway ──/chat──▶ Maritime ──▶ the agent VM
                                 ◀───────────── agent replies through Inkbox ◀───────────────┘
```

### Railway steps

1. Create a Railway project and a service from this repository. Set the Dockerfile path to `deploy/Dockerfile.gateway`.
2. Add a volume mounted at `/data`. Set `GATEWAY_DATA_DIR=/data`. The gateway keeps `users.json` there.
3. Set the variables in the table below. `GATEWAY_PUBLIC_URL` is the Railway domain with `https://`.
4. Set `GATEWAY_TRUST_PROXY=1`. Railway sits in front of the service, so the rate limits must key on `X-Forwarded-For`.
5. Deploy. Keep one replica. Open the domain, sign up, then check `GET /health`.

A `railway.json` for the service is in the gateway README. Its health check path is `/health` and its start command is `node packages/gateway/dist/main.js`.

Any other host works the same way: run the gateway image, give it a persistent directory, point `GATEWAY_PUBLIC_URL` at it. The gateway can also run as an always-on Maritime agent with `publicWeb`.

### Environment

| Variable | Required | Meaning |
|---|---|---|
| `GATEWAY_PUBLIC_URL` | yes | The https URL Inkbox can reach. Used for webhook subscriptions and connect links. |
| `MARITIME_API_KEY` | yes | `mk_` key that creates agents and calls `/chat`. |
| `INKBOX_ADMIN_API_KEY` | for signup | Org-wide Inkbox key. Without it the gateway relays for existing users only and the signup form becomes a notice. |
| `GATEWAY_SIGNUP_SECRET` | yes when signup is on | Invite code. Every signup bills your Maritime wallet and Inkbox plan, so signup is closed without it. |
| `GATEWAY_ALLOW_OPEN_SIGNUP` | no | `1` runs the form without an invite code, on purpose. |
| `GATEWAY_TRUST_PROXY` | behind a proxy | `1` counts signups by the first `X-Forwarded-For` address. |
| `GATEWAY_DATA_DIR` | no | Where `users.json` lives. Default `./.instinct-gateway`. Mount a volume. |
| `INSTINCT_AGENT_IMAGE` | no | The image each new agent runs. Default `ghcr.io/mariagorskikh/open-instinct-agent:latest`. Point it at your own. |
| `INSTINCT_IDLE_TTL_SECONDS` | no | Idle seconds before a VM sleeps. Default 900. |
| `ANTHROPIC_API_KEY` | no | Copied into each new agent as a secret. |
| `INSTINCT_USE_MARITIME_LLM` | no | `1` uses Maritime's metered proxy instead of your key. |
| `INSTINCT_MARITIME_MODEL` | no | Model id behind the proxy. Default `gpt-5.4`. |
| `COMPOSIO_API_KEY`, `COMPOSIO_TOOLKITS` | no | Apps for each new agent. |
| `AMPLE_SIGNUP` | no | `1`: each new agent can put the sites it builds online, in an Ample account of its own ([AMPLE.md](AMPLE.md)). |
| `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET`, `STRIPE_PUBLISHABLE_KEY` | no | Stripe Link wallet for each new agent. The gateway also sets each agent's `LINK_REDIRECT_URI` to its own callback. |
| `PORT` | no | Default `8787`. Railway injects its own. |
| `MARITIME_API_URL`, `INKBOX_BASE_URL` | no | Override the API hosts for staging. |

### The signup page

`GET /` serves a form: name, phone, optional email, handle, and the invite code when `GATEWAY_SIGNUP_SECRET` is set. Submitting it calls `POST /api/signup`.

Signup then runs six steps, saving after each one so a crash resumes instead of creating a second billed agent:

1. Create the Inkbox identity with iMessage on.
2. Mint an API key scoped to that identity. It goes to the agent as `INKBOX_API_KEY`.
3. Create the webhook signing key. It stays in the gateway.
4. Subscribe Inkbox webhooks to `<GATEWAY_PUBLIC_URL>/webhooks/inkbox/<userId>`.
5. Create the Maritime agent from `INSTINCT_AGENT_IMAGE` with `desktop: true` and `externalId: <userId>`. An agent with that `externalId` is reused if it exists.
6. Mark the record `ready`.

A phone that already has an agent gets a neutral "Check your phone" answer. No second agent is created and nothing about the existing record is revealed.

### The connect page

After signup the person lands on `GET /connect/:userId`. It shows:

- the Inkbox router number,
- the exact text to send, `connect @<handle>`,
- an `sms:` button that opens Messages with that text filled in,
- a QR code for the same, when Inkbox can produce one for this handle,
- a status line that refreshes every 5 seconds while provisioning runs.

The person sends the text. Inkbox links their phone to the identity. The first `imessage.received` webhook arrives and the agent introduces itself.

## How inbound reaches a sleeping agent

A Maritime VM has no public port of its own. Only Maritime's authenticated API reaches `/chat`. So something outside the VM has to receive the Inkbox webhook and hand it to Maritime. There are two ways.

### 1. The gateway relay (works today)

Inkbox posts the signed webhook to the gateway. The gateway verifies the signature, drops duplicates and delivery receipts, and forwards the event to that person's agent through:

```
POST https://api.maritime.sh/api/agents/{id}/chat
Authorization: Bearer mk_...
{"message": "@@instinct-event@@{...}", "conversation_id": "..."}
```

Maritime wakes the VM and posts to the agent's `/chat`. The server sees the `@@instinct-event@@` envelope, treats it as a verified Inkbox event, and replies to the person through Inkbox. The HTTP `response` is empty. Nothing comes back through the gateway.

For a single user without the gateway, the fallback is `instinct dev --tunnel` on your own machine. That runs the server locally and skips the Maritime VM.

### 2. Zero relay: a native signed webhook (possible future platform feature)

Maritime has a signed-webhook feature. An agent gets one public address, `https://api.maritime.sh/w/{agentId}/{path}`. Maritime checks the signature before it touches the agent, wakes the VM, and forwards the exact bytes to `/{path}` on the agent's port. The public API (`PUT /api/agents/{id}/signed-webhook` with `path`, `scheme` and `secret`) currently accepts one signature scheme, and it is not Inkbox's.

If Maritime adds a scheme that verifies Inkbox's headers (`X-Inkbox-Signature` as HMAC-SHA256 over `X-Inkbox-Request-ID + "." + X-Inkbox-Timestamp + "." + raw body`, with a replay window), the gateway becomes optional for a single user. The agent server already verifies that signature on `POST /webhooks/inkbox` and answers `204`, so no change to this repository is needed when the platform supports it. The steps would be:

1. Register the agent's webhook route with Maritime. The secret is the Inkbox signing key from `<dataDir>/secrets/inkbox.json`, the same value the agent holds as `INKBOX_SIGNING_KEY`. The key needs the `secrets` scope.
2. Subscribe the Inkbox identity's webhooks to the returned `url` (`POST /api/v1/webhooks/subscriptions` with `url`, `event_types` and `agent_identity_id`, using the admin key).

Inkbox would then post straight to Maritime. Maritime verifies, wakes, and forwards to the agent's `POST /webhooks/inkbox`, which verifies the same signature a second time. No gateway, no `users.json`, no relay process. Until then, use the gateway relay or `instinct dev --tunnel`.

| | Gateway relay | Signed webhook |
|---|---|---|
| Works today | yes | when the platform supports Inkbox's scheme |
| Extra service to run | yes | no |
| Who verifies the signature | gateway, then the agent trusts the envelope | Maritime, then the agent again |
| Signup and connect pages | yes | no; use `instinct init` and `instinct connect` |
| Dedup of repeated deliveries | gateway | the agent's handler |

## Costs and limits

| Item | Value | Where it comes from |
|---|---|---|
| VM size with a desktop | `desktop: true` forces 4 GiB memory and 2 vCPU | Maritime `AgentCreate` |
| VM size without a desktop | Maritime's agent default (2 GiB) | `--no-desktop` |
| Seat plan | A computer or desktop agent takes one slot of a paid seat plan. Confirm the plan before the first screen action; an unentitled account gets `402 no_plan`. | Maritime billing |
| Idle TTL | 900 seconds by default. `0` means always on and always billed. | `--idle`, `INSTINCT_IDLE_TTL_SECONDS` |
| Wake time | About 1 to 3 seconds from snapshot | Maritime docs |
| Reply budget | Maritime waits 30 s for `POST /chat`. The server answers within `INSTINCT_REPLY_BUDGET_MS` (default 20 s) and finishes long work in the background, sending the final text through Inkbox. | `@open-instinct/server` |
| Agent creation | 30 creates per minute per key. Each create debits the Maritime wallet; a `402` shows the server's explanation. | Maritime agents API |
| Metered LLM proxy | A per-user spend budget applies when `useMaritimeLlm` is on. Raise it with the LLM spend limit in Maritime. | Maritime LLM proxy |
| Gateway signup caps | 5 accepted signups per client address per 10 minutes; at most 20 users provisioning or created in the last hour | gateway |
| Inkbox plan | Free: 3 identities, shared router, 2,000 iMessages a month, 3 unique recipients. Developer: 10 identities, 10 recipients. Startup: 100 identities, 100 recipients. The "unique recipients" cap bounds how many humans one deployment can text. | inkbox.ai/pricing |
| Webhook body | 1 MiB on Maritime's signed-webhook route and on the agent server | both |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `instinct deploy` returns `402` | Maritime wallet is empty or the seat plan does not allow a desktop | Top up or upgrade in the Maritime dashboard. The `402` body explains which. |
| `instinct deploy` returns `401` or `403` | The `mk_` key lacks `provision` or `deploy` | Mint a key with `provision`, `deploy`, `secrets`, or `manage`. |
| Agent never becomes healthy | The server bound the wrong port | Do not set `PORT` by hand in the agent env. Maritime injects `18789`. Check the agent logs in the dashboard. |
| `/chat` through Maritime times out | A long tool run or a slow first wake | The server acks within 20 s and finishes in the background. Lower `INSTINCT_REPLY_BUDGET_MS` if replies still miss the 30 s window. |
| iMessage reaches Inkbox but the agent is silent | No webhook subscription points at a reachable URL | Run the gateway or use `instinct dev --tunnel`. Check Inkbox's delivery log for `401` or `404`. |
| Gateway returns `401` on `/webhooks/inkbox/:userId` | Signature mismatch; the stored signing key is not the one Inkbox uses | Compare the key in `users.json` with the identity's key in Inkbox. Rotate with `InkboxProvisioner.createSigningKey` if needed. |
| Gateway returns `404` on `/webhooks/inkbox/:userId` | Unknown user id, often after a redeploy without the volume | Mount `GATEWAY_DATA_DIR` on a persistent volume. |
| Gateway refuses to start | `INKBOX_ADMIN_API_KEY` is set but `GATEWAY_SIGNUP_SECRET` is not | Set an invite code, or set `GATEWAY_ALLOW_OPEN_SIGNUP=1` on purpose. |
| Every visitor hits the signup rate limit | All requests share the proxy's address | Set `GATEWAY_TRUST_PROXY=1` behind Railway or any reverse proxy. |
| Signup stuck in "Setting up" | A provisioning step failed (Inkbox `402` plan cap, Maritime `402`, image pull) | Check gateway logs. Records left in `provisioning` resume on the next boot or on a repeat of the same signup. |
| Two replies to one message | Two gateway replicas each forwarded the event | Keep one replica. |
| Desktop tools missing | `INSTINCT_COMPUTER=auto` found no `desktopd` and no `MARITIME_API_KEY` | Create the agent with the desktop (drop `--no-desktop`), or give the agent a key with the `computers` scope for the hosted MCP. |
| `openai-compatible` model errors with `--maritime-llm` | The proxy budget is spent | Raise the LLM spend limit in Maritime or switch to your own `ANTHROPIC_API_KEY`. |
| Apps tools missing although `COMPOSIO_API_KEY` is set | `config.json` was seeded with `apps.enabled: false` | Run `instinct init --name <you> --apps` and redeploy, or set the key before the first boot. |
| Payments tools missing | One of the three Link variables is unset | Set `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET` and `STRIPE_PUBLISHABLE_KEY` together. |

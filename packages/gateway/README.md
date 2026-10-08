# @open-instinct/gateway

The gateway is the small, always-on front door for a multi-user Open Instinct deployment. One gateway serves many people. Each person's agent runs in its own Maritime microVM and sleeps when idle; the gateway is what wakes it when a message arrives.

It does three things:

1. **Signup.** A static page where a person enters a name, phone, optional email, a handle and (optionally) an invite code. The gateway then provisions everything the agent needs.
2. **Connect.** A page with the Inkbox router number, the exact `connect @handle` command, an `sms:` button that opens Messages with the command filled in, and a QR code for the same.
3. **Relay.** Inkbox posts signed webhooks (iMessage, SMS, email, A2A) to `/webhooks/inkbox/<userId>`. The gateway verifies the signature, drops duplicates and delivery receipts, and forwards the event to that user's agent through `POST https://api.maritime.sh/api/agents/<agentId>/chat`. Maritime wakes the VM and the agent answers the human directly through Inkbox.

The gateway holds no conversation state and never sees the model. It is a relay with a signup form.

```
person's iPhone ──iMessage──▶ Inkbox ──signed webhook──▶ gateway ──/chat──▶ Maritime ──▶ the agent VM
                                 ◀───────────── agent replies through Inkbox ◀───────────────┘
```

## Routes

| Method | Path | What it does |
|---|---|---|
| `GET` | `/` | Landing page with the signup form (or a notice when signup is disabled) |
| `GET` | `/health` | `{ ok, users, signup }` |
| `POST` | `/api/signup` | JSON or form body `{ name, phone, email?, handle, inviteCode? }`. A new signup gets `202 { userId, connectUrl, status }` (JSON) or a 303 to `/connect/:userId` (form). A phone that already has an Instinct, or a repeat of the same signup, gets the neutral `202 { status: "pending" }` or a "Check your phone" page; see Security notes. `429` when the per-address or global cap is hit |
| `GET` | `/connect/:userId` | Connect page with router number, command, `sms:` button, QR (when Inkbox can produce one for this handle) and status. Refreshes itself every 5 s while provisioning |
| `GET` | `/api/users/:userId` | Status JSON without secrets or personal fields (`status`, `handle`, masked phone, `hasAgent`, `hasError`) |
| `POST` | `/webhooks/inkbox/:userId` | Inkbox webhook intake. `404` unknown user, `401` bad signature, otherwise `204` at once and the forward happens in the background |
| `GET` | `/oauth/link/callback/:userId?code&state` | Stripe Link OAuth redirect. Wraps `{ type: "link.oauth_callback", code, state }` in the event envelope, relays it to that user's agent through Maritime `/chat`, and shows a "Connected, go back to your messages" page. The agent holds the PKCE verifier and finishes the token exchange |

Validation: phone must normalize to E.164 (`+14155550123`; a bare 10-digit US number is accepted), handle must match `[a-z0-9-]{3,40}` (a leading `@` and upper case are normalized away) and may not be the reserved `owner`, email is optional but checked when given.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `GATEWAY_PUBLIC_URL` | yes in production | The https URL Inkbox can reach, e.g. `https://instinct.example.com`. Used for webhook subscriptions and connect links. Defaults to `http://localhost:<PORT>` with a warning |
| `MARITIME_API_KEY` | yes | `mk_...` key with permission to create agents and call `/chat` |
| `INKBOX_ADMIN_API_KEY` | for signup | Org-wide Inkbox key used to create identities, mint identity-scoped keys, signing keys and webhook subscriptions. Without it the gateway runs in relay-only mode and the signup form is replaced by a notice |
| `INSTINCT_AGENT_IMAGE` | no | Image built from `deploy/Dockerfile.agent`. Default `ghcr.io/mariagorskikh/open-instinct-agent:latest` |
| `GATEWAY_SIGNUP_SECRET` | yes when signup is on | Invite code. The form shows an "Invite code" field and `/api/signup` rejects requests without the exact value. With `INKBOX_ADMIN_API_KEY` set and no secret, the gateway refuses to start unless `GATEWAY_ALLOW_OPEN_SIGNUP=1` |
| `GATEWAY_ALLOW_OPEN_SIGNUP` | no | `1` runs the signup form without an invite code, on purpose. Every signup bills your Maritime wallet and Inkbox plan, so the gateway logs a warning at boot and relies on the rate limits below |
| `GATEWAY_TRUST_PROXY` | no | `1` counts signups by the first `X-Forwarded-For` address instead of the socket address. Set it behind Railway, Fly or a reverse proxy you run; never on a host reachable directly |
| `ANTHROPIC_API_KEY` | no | Passed to every new agent as a secret env var so it can call the model. Other Pi provider keys can be passed the same way by extending `provisionUser` in your own fork |
| `INSTINCT_USE_MARITIME_LLM` | no | `1` sets `useMaritimeLlm: true` on each agent so Maritime injects its metered `OPENAI_API_KEY` and `OPENAI_BASE_URL`, and sets `INSTINCT_MODEL=openai-compatible/<model>` so the agent uses them. For deployments without a model key of their own |
| `INSTINCT_MARITIME_MODEL` | no | Model id behind the Maritime proxy. Default `gpt-5.4` |
| `COMPOSIO_API_KEY` | no | Passed to every new agent as a secret env var; enables Gmail, Calendar and the other Composio toolkits |
| `AMPLE_SIGNUP` | no | `1` lets each person's agent put the sites it builds online, in an Ample account of its own that it signs up for on its first deploy (see docs/AMPLE.md). Only the switch is passed on; an Ample credential set on the gateway is never forwarded |
| `COMPOSIO_TOOLKITS` | no | Comma-separated toolkit slugs sent with the key. Default `gmail,googlecalendar,googlecontacts`. The agent only enables apps when this is non-empty, so the gateway always sends it alongside the key |
| `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET`, `STRIPE_PUBLISHABLE_KEY` | no | Stripe Link Agent Wallet credentials. When `LINK_CLIENT_ID` is set, all three are copied into each agent's env (the secret marked secret) together with `LINK_REDIRECT_URI=<GATEWAY_PUBLIC_URL>/oauth/link/callback/<userId>` |
| `GATEWAY_DATA_DIR` | no | Where `users.json` lives. Default `./.instinct-gateway`. Mount a volume here |
| `PORT` | no | Default `8787`. Railway injects its own |
| `MARITIME_API_URL`, `INKBOX_BASE_URL` | no | Override the API hosts (staging, tests) |
| `INSTINCT_IDLE_TTL_SECONDS` | no | Idle seconds before an agent VM sleeps. Default 900 |

`src/main.ts` is the only file that reads `process.env`. Everything else takes options, so you can embed `createGateway` in your own server.

## What signup provisions

`provisionUser` runs six steps. Each step saves the user record before the next one starts, so a crash or a 5xx leaves a record that the next attempt resumes instead of creating a second identity or a second (billed) agent.

1. `InkboxProvisioner.provisionIdentity({ handle, displayName, imessage: true, phone: false })`. The identity gets a mailbox and an iMessage line on the shared router. Taken handles get a `-2`, `-3` suffix; the record keeps the final handle.
2. `mintIdentityKey(identityId)`: an API key scoped to that one identity. It goes to the agent as `INKBOX_API_KEY` and is stored in `users.json` so a redeploy can reuse it.
3. `createSigningKey(handle)`: the per-identity webhook signing key. It stays in the gateway.
4. `subscribeWebhooks(identityId, "<GATEWAY_PUBLIC_URL>/webhooks/inkbox/<userId>")` for `imessage.received`, `imessage.reaction_received`, `text.received`, `message.received`, `a2a.task.created`, `a2a.task.message`, `a2a.task.canceled`, `a2a.sent_task.updated`.
5. `POST https://api.maritime.sh/api/agents` with the BYO contract: `framework: "custom"`, `imageName`, `exposedPort: 18789`, `healthCheckPath: "/health"`, `desktop: true`, `externalId: <userId>`, `idleTtlSeconds`, a one-paragraph persona, `useMaritimeLlm: true` when `INSTINCT_USE_MARITIME_LLM=1`, and `initialEnvVars` for `PORT=18789` (the same number as `exposedPort`, so the bound port and the recorded port never drift), `INKBOX_API_KEY` (secret), `INKBOX_AGENT_HANDLE`, `INKBOX_IDENTITY_ID`, `INSTINCT_OWNER_NAME`, `INSTINCT_OWNER_PHONE`, `INSTINCT_OWNER_EMAIL`, `ANTHROPIC_API_KEY` (secret), `COMPOSIO_API_KEY` (secret) with `COMPOSIO_TOOLKITS`, `INSTINCT_MODEL` when the Maritime LLM is on, `LINK_*` and `STRIPE_PUBLISHABLE_KEY` when configured, and `INSTINCT_COMPUTER=auto`. The gateway lists agents by `externalId` first and reuses one when it exists.
6. The record is marked `ready`. The connect page flips from "Setting up" to "Ready".

A record left in `provisioning` by a crash or a redeploy is resumed at the next boot (`resumePending()` runs after `listen`), and a repeat of the same signup restarts it too. Only `ready` records are left alone.

The person then texts `connect @handle` to the router number. Inkbox links their phone to the identity, the first `imessage.received` webhook arrives, and the agent introduces itself.

The connect page builds its `sms:` button from the router number and this user's handle. The QR code comes from Inkbox's triage endpoint called with the user's own identity key; the org-wide endpoint answers with a placeholder handle, and a QR that does not name the user's handle is not shown.

## Running locally

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use
pnpm install
pnpm -r build
MARITIME_API_KEY=mk_... INKBOX_ADMIN_API_KEY=... GATEWAY_PUBLIC_URL=https://<your tunnel> \
  node packages/gateway/dist/main.js
```

Inkbox must be able to reach `GATEWAY_PUBLIC_URL`, so use a tunnel (Cloudflare, ngrok, Tailscale Funnel) when developing on a laptop. Without `INKBOX_ADMIN_API_KEY` the gateway still relays for users already in `users.json`.

## Deploying on Railway

1. Create a Railway project and a service from this repository. Set the root to the repo and the Dockerfile to `deploy/Dockerfile.gateway`.
2. Add a volume mounted at `/data` and set `GATEWAY_DATA_DIR=/data`.
3. Set the variables above. `GATEWAY_PUBLIC_URL` is the Railway domain (or your custom domain) with `https://`.
4. Deploy. Open the domain, sign up, and check `/health`.

`railway.json` for the service:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "deploy/Dockerfile.gateway"
  },
  "deploy": {
    "startCommand": "node packages/gateway/dist/main.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 60,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5,
    "numReplicas": 1
  }
}
```

Keep one replica. `users.json` is a single file and the duplicate-event cache is in memory; two replicas would each forward the same event once.

Any other host works the same way: run the image, give it a persistent directory, point `GATEWAY_PUBLIC_URL` at it. The gateway can also run as an always-on Maritime agent with `publicWeb`.

## Security notes

**Signatures.** Every webhook is verified before anything is parsed: HMAC-SHA256 over `${X-Inkbox-Request-ID}.${X-Inkbox-Timestamp}.${raw body}` compared in constant time against `X-Inkbox-Signature: sha256=<hex>`, with a 5 minute timestamp window. Verification uses the signing key stored for that `userId`, so a valid signature for one user cannot be replayed against another. The 401 is computed before the response; the forward to Maritime happens after the 204 so Inkbox never waits on the agent.

**Replay and noise.** Events are deduplicated by Inkbox event id (an in-memory LRU of 5000). Delivery receipts (`*.sent`, `*.delivered`, `*.failed`, `*delivery*`) are dropped; the agent only hears about messages, reactions and A2A tasks. An event that fails to forward after three attempts releases its id so it can be replayed by hand.

**Secrets at rest.** `users.json` holds identity API keys and signing keys. It is written through a temp file and rename with mode `0600`, in a directory created `0700`. Nothing in it is returned by `/api/users/:id` or rendered into a page; phone numbers are masked. The Maritime key, the Inkbox admin key and model keys live only in the process environment. Secrets passed to agents are marked `isSecret` so Maritime encrypts them and masks them in its dashboard. Logs carry ids and statuses, never key material.

**Invite codes.** Each signup creates an Inkbox identity and a Maritime agent, both of which cost money, so signup is closed by default: with `INKBOX_ADMIN_API_KEY` set the gateway refuses to start until `GATEWAY_SIGNUP_SECRET` is set or `GATEWAY_ALLOW_OPEN_SIGNUP=1` says the open form is intended. The code is compared in constant time.

**Rate limits.** `/api/signup` allows 5 accepted signups per client address per 10 minutes and at most 20 users that are still provisioning or were created in the last hour; past either cap it answers `429`. Counts are in memory and reset on restart. Validation errors do not count. Set `GATEWAY_TRUST_PROXY=1` behind a proxy so the limit keys on the real client, or every visitor shares the proxy's address.

**No phone oracle.** A signup whose phone already has an Instinct, or that repeats an existing signup, gets the same answer whether the caller is the owner or a stranger: `202 { status: "pending" }`, or a "Check your phone" page that shows the router number and the command for the handle the caller typed. Nothing about the existing record is returned, and no second agent is created. The optional `notifyExisting(user, connectUrl)` hook on `createGateway` is where an operator can send the real connect link to the phone itself. Handle conflicts answer a generic `400 could not create` on an open form; only invitees (`GATEWAY_SIGNUP_SECRET` set) get the explicit `409 handle taken`. `/api/users/:id` returns neither the name nor the provisioning error text. The connect page itself still shows the name and handle to whoever holds the 64-bit id; a one-time token sent to the phone would close that too and is the next step.

**What the gateway cannot do.** It cannot read or send messages: identity keys are handed to the agent and used only there. It cannot run tools, spend money or see memory. Compromising the gateway yields the keys in `users.json`, which is why that file and the environment are the things to protect. Rotate a user's identity key with `InkboxProvisioner.mintIdentityKey` and update the agent's env if you ever need to.

## Programmatic use

```ts
import { createGateway, UserStore } from "@open-instinct/gateway";
import { InkboxProvisioner } from "@open-instinct/inkbox";

const server = createGateway({
  store: new UserStore("/data"),
  publicUrl: "https://instinct.example.com",
  inkbox: new InkboxProvisioner({ adminApiKey: process.env.INKBOX_ADMIN_API_KEY! }),
  maritime: { apiKey: process.env.MARITIME_API_KEY!, agentImage: "ghcr.io/mariagorskikh/open-instinct-agent:latest" },
  signupSecret: process.env.GATEWAY_SIGNUP_SECRET,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
});
server.listen(8787);
```

`createGateway` returns a `GatewayServer`: a `node:http` server with one extra method, `resumePending()`, which restarts provisioning for records left in `provisioning`. Optional hooks: `routerInfoFor(user)` for per-user router info (QR), `notifyExisting(user, connectUrl)` for the duplicate-phone path, `signupLimits`, `trustProxy`, `composioToolkits` and `link`. `checkSignupPolicy(cfg)` is the startup rule `startGateway` applies.

`relayEvent`, `relayGatewayEvent`, `provisionUser`, `validateSignup`, `renderLanding`, `renderConnect` and `renderPending` are exported separately for other front doors.

## Tests

```bash
pnpm --filter @open-instinct/gateway test
```

Covers: signature verification (valid, wrong key, tampered body, stale timestamp), the exact `/chat` body, delivery-event and duplicate suppression, retry on 429/503/network errors, provisioning step order and resume after a failure, resume of records left in `provisioning`, Maritime agent reuse by `externalId`, the create body (port, toolkits, Maritime LLM, Link passthrough), signup validation, the startup refusal, the neutral duplicate-phone response, per-address and global `429`s, the per-handle `sms:` link and QR rule, the Link OAuth callback relay, and the HTTP routes end to end against a fake Inkbox and a fake Maritime.

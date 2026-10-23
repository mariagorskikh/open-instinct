# Executor, brain, computer keys and the admin API

This page is the operator's runbook for the three systems the gateway manages on
behalf of every agent: the **executor** (a custom Composio toolkit that fronts
the self-hosted executor MCP), the **company brain** (a person's GitHub repo
pushed into their agent's machine), and the **narrow computer key** (so the
fleet's Maritime key never reaches an agent). It also documents the
bearer-protected desktop admin endpoint.

App connections (Gmail, Calendar, …) are covered in [COMPOSIO.md](./COMPOSIO.md).
Template mechanics are covered in [TEMPLATES.md](./TEMPLATES.md).

## The env vars

Set on the gateway (never on an agent):

| Variable | Required | Meaning |
|---|---|---|
| `COMPOSIO_API_KEY` | for the executor | The project's Composio key. With `EXECUTOR_MCP_URL` + `EXECUTOR_MCP_TOKEN` present, the gateway registers the executor toolkit at boot. |
| `EXECUTOR_MCP_URL` | for the executor | The executor's MCP endpoint, registered as the toolkit's `app_url`. |
| `EXECUTOR_MCP_TOKEN` | for the executor | Bearer sent to the executor on every call. Lives only in Composio's auth config and connected-account state; never forwarded to agents. |
| `GATEWAY_ADMIN_TOKEN` | for the admin API | Bearer for `POST /api/admin/desktop/<userId>` and `POST /api/admin/reprovision/<userId>`. Unset disables both endpoints (503). |
| `MARITIME_COMPUTERS_API_KEY` | no | Operator-minted computer key; wins over the gateway's own mint. |
| `GITHUB_TOKEN` | no | Fleet fallback token for brain pushes. A person's own token always wins; public repos need no token. |

All three executor vars are required. Any missing piece logs
`composio.executor_disabled` and the gateway runs without the executor; template
lists that name `custom_executor` are then stripped from the agents' env
(`custom_executor` never reaches an agent that cannot authenticate it).

## Boot sequence

Before the gateway listens:

1. **Computers key** — `override → stored → mint` (see below). Non-fatal.
2. **Composio executor boot** — idempotent: upsert the `CUSTOM_EXECUTOR`
   toolkit, resolve or create its API-key auth config, connect the gateway's own
   bootstrap account (`instinct-gateway`), then sync tool definitions from the
   executor MCP. Success logs `composio.executor_ready` with
   `composio.executor_synced`.

Each step has a 30 s timeout; a hung or failed boot logs loudly
(`*_timeout` / `composio.executor_unavailable`) and the gateway still comes up.
Oxygen and Postiz register the same way, independently of the executor (DCR
auth config / toolkit upsert, logged `composio.oxygen_ready` /
`composio.postiz_ready`, or `*_unavailable` when the wrapper URL is unset or the
upsert fails). Healthy boot ends with:

```
gateway.listening {executor: true, oxygen: true, postiz: true, computer: true, adminApi: true}
```

## How an agent gets the executor

The `gtm-ai` template ships:

```yaml
env:
  COMPOSIO_MODE: router
  COMPOSIO_TOOLKITS: gmail,googlecalendar,custom_executor
```

Why router mode: the agent's **direct** mode injects
`preload: {tools: "all"}` for the session, and that preload does **not** include
project custom-toolkit tools (verified: only the meta router tools appear). In
router mode the session loads the pinned toolkit list explicitly, and the
executor's five tools (`CUSTOM_EXECUTOR_EXECUTE`, `SKILLS`, `RESUME`,
`LIST_ARTIFACTS`, `SHOW_ARTIFACT`) are reached at runtime through
`COMPOSIO_SEARCH_TOOLS` → `COMPOSIO_MULTI_EXECUTE_TOOL`. Trade-off: everything
goes through search + multi-execute (one extra round-trip, router-shaped calls)
instead of direct named-tool calls.

At provision time the gateway:

1. Checks whether the effective toolkit list (template env, else gateway
   `COMPOSIO_TOOLKITS`, else the default) requests `custom_executor`.
2. Reuses the person's stored connected-account id while it still resolves
   `ACTIVE`, otherwise creates one — **`user_id` is the person's handle**, the
   same id the agent signs its Composio sessions with.
3. Saves `composioAccountId` on the record. Every failure here is logged
   (`provision.composio_account_failed`) and never fails provisioning.

Without a configured composio platform, `custom_executor` is filtered out of
`COMPOSIO_TOOLKITS` in the agent's env.

## Per-person connections (Postiz key, Oxygen OAuth)

The connect page's **Connections** card carries everything one person adds
themselves: the company brain, a **Postiz** public-API key (BYOK), and the
**Oxygen** OAuth button. Two gateway-managed toolkits are per-person by design,
and an agent's `COMPOSIO_TOOLKITS` reflects exactly what its owner connected:

- `custom_postiz` — in the list only while the wrapper booted **and** the person
  saved their own key. The key mints a Composio connected account
  (`postizComposioAccountId`, reused while active; a new key re-mints).
- `custom_oxygen` — in the list only while the DCR registration booted **and**
  the person finished their OAuth dance
  (`oxygenComposioAccountId`). Registration alone never puts a dead toolkit in
  front of an agent.
- `custom_executor` — fleet-managed: in the list whenever the executor booted;
  the account mints silently at provision.

### The Oxygen connect flow

Oxygen is a DCR OAuth toolkit: there is no shared credential, so each person
approves in their own browser (Clerk at `oxygen-agent.com`, discovered from the
toolkit's `/.well-known/oauth-authorization-server`).

1. `GET /connect/<userId>/oxygen` (the page's **Connect Oxygen** button) —
   requires `composio.oxygen_ready`, else 503. Creates the connected account
   (`INITIATED`) and Composio's hosted link via
   `POST /api/v3.1/connected_accounts/link`, stores it as
   `oxygenPendingAccountId`, and 302s the browser to the link.
2. The person approves at Composio, then at Clerk; Composio redirects them to
   `GET /oauth/composio/callback?user=<id>&connectedAccountId=<id>`
   (the gateway set the `callback_url`).
3. The callback verifies the account — `ACTIVE` (polled up to 10 s; the
   redirect can land before the token exchange finishes), `user_id` equal to
   the person's handle, toolkit `custom_oxygen` — then saves
   `oxygenComposioAccountId`, clears the pending id, re-syncs the agent's env
   (so `custom_oxygen` reaches the toolkit list; the agent picks it up on its
   next wake) and 303s back to the connect page. Any mismatch or Composio
   `error` parameter renders "Oxygen not connected", changes nothing, and logs
   `connect.oxygen_verify_failed` with what Composio actually reported.
   Success logs `connect.oxygen_connected`.

4. **The callback is not the only way in.** Observed live: Composio can flip the
   account to `ACTIVE` and then fail its own final redirect
   (`dashboard.composio.dev/redirect?status=failed&error=Invalid+or+expired+state`),
   so the browser never reaches step 2 and `oxygenComposioAccountId` stays unset.
   `healOxygenAccount` covers this: it verifies the recorded pending account
   (`ACTIVE`, owner handle, toolkit `custom_oxygen`) and promotes it — on the
   admin reprovision, on a ready-agent reconnect, during provisioning, and on a
   plain visit to the connect page (which then re-syncs the env too). Success
   logs `provision.oxygen_account`. A saved id is never dropped for a transient
   `accountActive` miss — unlike Postiz, Oxygen cannot re-mint without a fresh
   browser dance, so the id is only replaced by a newer completed one.

A person whose agent is still provisioning can connect too: the account rides
on the record and provision applies it when the env is first built.

### The `CUSTOM_` upsert gotcha

Composio's `POST /api/v3.1/custom/toolkits/upsert` **prefixes `CUSTOM_`
itself**: sending `CUSTOM_POSTIZ` registers `CUSTOM_CUSTOM_POSTIZ`, which
neither auth-config creation nor the agent's tool router can ever find (this is
why Oxygen silently never worked). The gateway therefore sends the bare names
(`POSTIZ`, `OXYGEN`). The executor keeps its prefixed slug — it lives on a
pre-existing `custom_executor` toolkit (auth config + 8 connections) that must
not be re-upserted; its boot finds the legacy config instead of creating one.

## The narrow computer key (fleet-key isolation)

An agent's own `MARITIME_API_KEY` must be able to open mcp.maritime.sh for its
hosted computer — and that credential must not be the fleet key. Probed ladder
against mcp.maritime.sh: end-user tokens and deploy-scoped keys are rejected; a
project key minted with `scopes: ["computers"]` works.

The gateway therefore mints `instinct-computers` once with the fleet key and
persists it in the data dir (`/data/computers-key.json`, mode 0600):

1. `MARITIME_COMPUTERS_API_KEY` set → use it, no Maritime call.
2. Stored file exists → `GET /api/v1/keys`; reuse while the id is active. If the
   list call fails (network/5xx), keep using the stored key rather than minting
   duplicates.
3. Otherwise → `POST /api/v1/keys {name: "instinct-computers", scopes: ["computers"]}`
   and store `raw_key`.

A deleted/disabled stored key is re-minted on the next boot. Any failure means
"agents run without a hosted computer" (`computers_key.failed`) — the in-VM
desktop still works. The key lands in every agent's env as
`MARITIME_API_KEY` (marked secret); the fleet key never does.

**Orphan keys:** wiping the data volume mints a fresh key and leaves the old one
active in Maritime. They are harmless but accumulate — list keys with the fleet
key and delete `instinct-computers` entries you do not recognize.

## The company brain

A person supplies a GitHub repo (`owner/repo`, a github.com URL, or a URL with
`/tree/<branch>`) at signup or from their connect page. The gateway normalizes
it, stores it, and pushes the repo's **text files** into the agent's volume
under `/data/brain` — at provision time and on every connect-page save (the page
responds immediately; the push runs in the background).

Rules the push enforces while walking the tree:

- Caps: 200 files, 256 KB per file, 3 MB total. Oversized content is skipped.
- Skipped directories: `.git`, `node_modules`, `dist`, `build`, `.next`, `vendor`,
  `.venv`/`venv`, `__pycache__`, `coverage`.
- Never fetched: credential-shaped files (`.env*`, `*.pem/key/p12/pfx/jks`,
  `id_rsa*`…), binaries (NUL bytes), extensions outside a text allowlist.
- Auth: the person's token, else the fleet `GITHUB_TOKEN`, else anonymous
  (public repos work with no token).

Token handling: stored on the record like every other secret, **never logged and
never rendered** — `publicUser` exposes only `hasBrain`, form error pages strip
it, and the connect form never echoes a saved token. Leaving the token box blank
on re-save keeps the saved one; an empty repo clears the repo *and* the token.

All brain failures (`provision.brain_failed`, `connect.brain_failed`) are
warnings; provisioning and the connect page succeed regardless.

## Admin: the desktop toggle

```
POST /api/admin/desktop/<userId>
Authorization: Bearer <GATEWAY_ADMIN_TOKEN>
{"enabled": true|false}
```

Answers: `503` while `GATEWAY_ADMIN_TOKEN` is unset, `401` on a wrong bearer,
`404` unknown user, `409` agent not ready, `400` bad body. Maritime's own
constraints pass through unchanged — including `402` when the org's desktop
seat cap is reached. The response is `{ok: true, desktop: …}`.

```
POST /api/admin/reprovision/<userId>
Authorization: Bearer <GATEWAY_ADMIN_TOKEN>
```

Recomputes the agent's full env from its template + current boot readiness
(executor/oxygen/postiz flags) and pushes only the differing keys to Maritime —
`{ok: true, synced, total, refreshed, postizAccountId, oxygenAccountId}`.
Secrets re-push every time (Maritime masks stored secret values, so a rotated
key can only be detected by sending it). Nothing is recreated: identity,
accounts and `maritimeAgentId` stay. The endpoint heals **before** it syncs —
Postiz BYOK (reuse-while-active, replace stale, mint missing) and Oxygen
(promote a completed-but-uncaptured dance) — so a healed toolkit id enters the
env in the same call; the response reports both account ids (`null` when the
owner has no key/dance or Composio is off). `provisionUser` runs the same heals
in the background whenever a ready agent's owner reconnects (same handle +
phone), so the endpoint is for healing without waiting for that.

**Agent-side toolkit list.** The synced `COMPOSIO_TOOLKITS` env is what the
agent *should* build its Composio session from, but until the agent image ships
the `loadConfig` override (env wins for `apps.toolkits`, like `INSTINCT_MODEL`),
an already-booted agent still reads the toolkit list from its `/data/config.json`
(file wins after first boot). For a new toolkit on an existing agent: edit the
agent's config through its shell (`python3 -c` patching
`config.json → apps.toolkits`, reply comes back on the chat probe), *then*
reprovision — the bounce makes the agent rebuild its session with the new list
(session mismatch is detected; the old `apps.json` session is replaced).

**Env writes do not reach a deployed container on their own.** Maritime keeps
env in a per-agent store, but a running or sleeping container keeps its own
copy: hot `POST …/reload-env` never changes the orchestrator process,
`POST …/restart` does not restart the container, a reload-triggered rebuild
re-applies the CREATE-time payload (stale for agents created before a var
existed), and waking from a sleep checkpoint restores the checkpointed env —
not the store. The only reliable application is a fresh container cycle:
`POST …/stop` then `POST …/start`, which deploys from the current store;
sleep checkpoints after that capture the new env, so later wakes keep it.
Every `syncAgentEnv` therefore ends with that bounce (`refreshed` reports it;
a failed bounce only warns — the store stays correct for the next sync). This
is why an agent can look "synced" in the store while its runtime still reports
`COMPOSIO_API_KEY missing`: check the *container*, not the store.

## One owner, many agents

Reuse keys on handle **and** phone together: the same details land on the
existing record (retry, lost connect page), while a fresh handle is a fresh
agent — one owner phone can run a fleet. The platform deploy flow
(`claim-machine` in founder-synergy-agent-platform) keeps one `agent_machines`
row per agent: in-flight rows refresh, settled rows mean the next deploy derives
`<base>-2`, `<base>-3`… and signs up a new gateway user. Same-handle re-signups
answer `202 {status:"pending", userId, connectUrl, …}` (the caller's own record
only) so a retry attaches to the row it already owns.

## Recovery procedures

**Toolkit `app_url` changed (409 on upsert).** `app_url` and `auth_schemes` are
immutable on an existing Composio toolkit, and syncing against the wrong URL
would silently keep serving stale tools. To move the executor to a new URL:
delete the `CUSTOM_EXECUTOR` toolkit (Composio dashboard or
`DELETE /api/v3.1/custom/toolkits/CUSTOM_EXECUTOR`), then restart the gateway —
boot recreates it, its auth config, the bootstrap account, and re-syncs. Expect
per-user connected accounts to be recreated on each person's next provision or
retry, which is harmless (the token rides in the account state).

**Executor token rotated.** The token lives in two places: the toolkit's auth
config credentials and each connected account's state. Changing only
`EXECUTOR_MCP_TOKEN` on the gateway updates nothing that already exists — the
list-first boot reuses the old auth config. Rotate by deleting the API_KEY auth
config for `CUSTOM_EXECUTOR` (and stale connected accounts if the executor
rejects old Bearer tokens), then restart. New accounts pick up the new token;
stored `composioAccountId` values that go inactive are replaced automatically on
the next provision.

**Executor down.** Boot fails soft: `composio.executor_unavailable`,
`executor: false` in `gateway.listening`, agents provision without
`custom_executor`. Bringing the executor back only requires a gateway restart —
no data migration, since the boot steps are idempotent.

**Computer key lost or revoked.** Delete the stale `computers-key.json` and
restart; the next boot mints a fresh `instinct-computers`. Existing agents keep
their old (now dead) env value until re-provisioned or edited — Maritime env
updates go through `POST /api/agents/<id>/env` + `restart` if you need to fix a
live agent by hand.

## Deploying gateway changes to the OCI VM

```
rsync -az --delete --exclude .git --exclude node_modules --exclude '**/node_modules' \
  --exclude dist --exclude '**/dist' --exclude .env --exclude '**/.env' \
  <repo>/ ubuntu@92.4.130.36:/opt/instinct-gateway-src/
```

On the VM (build detached — a dropped SSH must not kill it; `/var/log` is not
writable by `ubuntu`):

```
cd /opt/instinct-gateway-src
nohup sh -c "docker build -f deploy/Dockerfile.gateway -t instinct-gateway:latest . > ~/gateway-build.log 2>&1; echo BUILD_EXIT=\$? >> ~/gateway-build.log" >/dev/null 2>&1 &
tail -f ~/gateway-build.log        # wait for BUILD_EXIT=0
cd /opt/instinct-gateway && docker compose up -d --no-deps gateway
docker logs instinct-gateway --since 5m | grep -E "listening|executor|computers_key"
```

Compose lives at `/opt/instinct-gateway/docker-compose.yaml` (env lives there,
not in the source tree); the data volume is `gateway-data:/data`.

## Deploying the Postiz MCP wrapper

The gateway hands every agent the `custom_postiz` toolkit, which points at a
small stateless MCP server (`packages/postiz-mcp`) that relays to the
self-hosted Postiz public API. Each request carries that person's own Postiz
key (BYOK), so the wrapper never holds a credential.

Source syncs to `/opt/postiz-mcp-src` (same rsync flags as above; create the
dir once with `sudo mkdir -p /opt/postiz-mcp-src && sudo chown ubuntu:ubuntu
/opt/postiz-mcp-src`). Build detached:

```
cd /opt/postiz-mcp-src
nohup sh -c "docker build -f deploy/Dockerfile.postiz-mcp -t postiz-mcp:latest . > ~/postiz-mcp-build.log 2>&1; echo BUILD_EXIT=\$? >> ~/postiz-mcp-build.log" >/dev/null 2>&1 &
tail -f ~/postiz-mcp-build.log      # wait for BUILD_EXIT=0
```

Compose lives at `/opt/postiz-mcp/docker-compose.yaml`: it sets
`POSTIZ_API_URL=http://postiz:5000/api` (internal — reaches the Postiz stack on
the `postiz_postiz-network` bridge, no hairpin through Cloudflare), joins both
that network and the external `coolify` network, and carries Traefik labels for
`postiz-mcp.foundersynergy.network` with the `letsencrypt` certresolver, same
shape as the gateway. Bring it up with `cd /opt/postiz-mcp && docker compose
up -d`.

Point the gateway at it by adding this line to
`/opt/instinct-gateway/docker-compose.yaml` (env lives only there, not in the
source tree):

```
POSTIZ_MCP_URL: "https://postiz-mcp.foundersynergy.network/mcp"
```

then rebuild + restart the gateway as above (`docker compose up -d --no-deps
gateway`) and confirm the boot line:

```
docker logs instinct-gateway --since 5m | grep -E "postiz_ready|listening"
```

You want `composio.postiz_ready` and a `gateway.listening` line whose flags
include `"postiz":true`.

### DNS-lag workaround (VM-local curls)

The wrapper hostname resolves on public resolvers (1.1.1.1, 8.8.8.8) as soon
as the Cloudflare record is added, but the OCI VM's own resolver
(Oracle VCN, `169.254.169.254`) can lag minutes behind. A `curl` from the VM may
print `Could not resolve host` even though the service is healthy and the
gateway reaches it fine. Skip the local resolver and pin the IP:

```
curl --resolve postiz-mcp.foundersynergy.network:443:104.21.50.143 \
  https://postiz-mcp.foundersynergy.network/health
```

Expect `{"ok":true}`. To smoke the MCP surface end to end, `POST /mcp` with
headers `Content-Type: application/json`, `Accept: application/json,
text/event-stream`, and `Authorization: Bearer <postiz-api-key>`: an
`initialize` should return `serverInfo.name: "postiz-mcp"`, and a request
without the key must return 401.

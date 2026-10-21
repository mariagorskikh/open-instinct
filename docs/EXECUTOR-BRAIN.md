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
| `GATEWAY_ADMIN_TOKEN` | for the desktop toggle | Bearer for `POST /api/admin/desktop/<userId>`. Unset disables the endpoint (503). |
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
Healthy boot ends with:

```
gateway.listening {executor: true, computer: true, adminApi: true}
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

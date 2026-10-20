# Instinct Templates — Change Report

**Commit:** `2eea650` — `feat: instinct templates — gateway registry, persona/skills, desktop:false sizing`
**Branch:** `feat/templates-agent-gateway` → pushed to `origin`
**Scope:** `packages/gateway` (15 files changed, 563 insertions, 11 deletions)

---

## Summary

The gateway gained a first-class **template system**: declarative YAML registry entries that package a persona, standing instructions, skills, model choice, and VM sizing into a named, selectable deploy profile. Signup now accepts a `templateId`, the chosen template is persisted per user, and provisioning applies it end-to-end — env seeds, Maritime VM sizing, and skill files.

Two templates ship: **`default`** (general-purpose personal agent) and **`gtm-ai`** (AI-native GTM operator).

Three design decisions shape the implementation:

1. **Owner edits win.** Persona and instructions travel as env seeds (`INSTINCT_PERSONA`, `INSTINCT_INSTRUCTIONS`), not as overwrites — the agent seeds `/data/PERSONA.md` on first boot and re-seeds `/data/AGENTS.md` only until the owner edits it.
2. **`desktop: false` by default.** Templates own their hardware footprint; Maritime's forced 4 GiB / 2 vCPU desktop is skipped, and explicit `memMb`/`vcpus` are sent instead.
3. **Fail fast at boot, best effort at provision.** An invalid registry kills the gateway at startup; a skills push failure during provisioning only logs a warning.

---

## File-by-file changes

### New files (3)

| File | Lines | Purpose |
|---|---|---|
| `packages/gateway/src/templates.ts` | 156 | Template types, registry loader, validation |
| `packages/gateway/templates/` (4 files) | 98 | Shipped registry: 2 YAML + 1 persona + 1 skill |
| `packages/gateway/test/templates.test.ts` | 120 | Loader + shipped-registry assertions |

#### `src/templates.ts` — the registry loader

Exports:

- **Constants** — `TEMPLATE_ID_RE` (`^[a-z0-9][a-z0-9-]{0,39}$`, path-traversal safe), `DEFAULT_TEMPLATE_ID = "default"`, `TEMPLATE_API_VERSION = "instinct/v1"`.
- **`GatewayTemplate`** — the validated shape: `{ id, title, version, description, hardware: { cpu, ramGb, desktop }, model?, persona?, instructions?, skills, env }`. No secrets ever live in a template.
- **`TemplateError`** — dedicated error class for load/validation failures.
- **`defaultTemplateDir()`** — resolves `../templates` relative to the module, so it points at the shipped registry from both `src/` (vitest) and `dist/` (built gateway).
- **`TemplateRegistry`** — `ids()`, `get(id)` (falls back to `default` for malformed/missing ids), `resolve(id)` (throws on unknown).
- **`loadTemplateRegistry(dir?)`** — reads every `registry/<id>.yaml`, **fails fast** on any invalid entry, and requires `default.yaml` to exist.

Validation enforced per template:

- `api_version` must equal `instinct/v1`; `template.name` must equal the file name (catches copy-paste mistakes).
- `title` required; `version` must be semver; `description` required.
- `hardware.cpu` ∈ {1, 2, 4}; `hardware.ram_gb` ∈ {2, 4, 8, 16}; `desktop` must be explicit boolean (`true` only if literally `true`).
- `persona` resolved under `personas/` with a `startsWith(dir)` guard — path traversal (`../../etc/passwd`) is rejected as "persona file not found".
- Each `skills[]` entry must be a valid template id and have `skills/<name>/SKILL.md` on disk.
- `env` must be a flat map of scalars (nested objects rejected).

#### `templates/registry/default.yaml`

```yaml
api_version: instinct/v1
template: { name: default, title: Personal Instinct, version: 1.0.0, ... }
hardware: { cpu: 1, ram_gb: 4, desktop: false }
skills: []
env: {}
```

No persona, no skills — the stock personal agent, now desktop-less at 1 vCPU / 4 GB.

#### `templates/registry/gtm-ai.yaml`

```yaml
hardware: { cpu: 2, ram_gb: 4, desktop: false }
model: { provider: openai-compatible, default: gpt-5.4 }
skills: [gtm-playbook]
env: { COMPOSIO_TOOLKITS: gmail,googlecalendar }
```

Plus `persona: gtm-ai` (file reference) and an inline `instructions` block — house rules requiring **explicit owner approval** before any outbound send or CRM write, research-before-execution, and funnel progress reporting.

#### `templates/personas/gtm-ai.md` (17 lines)

The operator persona: focus areas (ICP research, outbound engines, CRM orchestration, inbound content) and operating rules (approval gates, no invented signals, owner's SOPs win over the shipped summary).

#### `templates/skills/gtm-playbook/SKILL.md` (43 lines)

Front-matter skill (`name`, `description`) with four plays: ICP qualification (PQS — Pain/Reachable/Timing scoring), a 4-touch outbound sequence draft (subject ≤6 words, body ≤120 words, draft-never-send), CRM hygiene rules (dedupe, 14-day staleness, never delete), and an inbound content loop (queue for approval).

### Modified files (10)

#### `src/validate.ts` (+9/−3)

- `SignupValue` gains `templateId: string`.
- `validateSignup` accepts `knownTemplates?: string[]`, reads `templateId`/`template_id` (defaults to `default`), and validates in two stages:
  - format → `"Template must be a short lowercase id."`
  - membership → `"That template is not available on this gateway."`

#### `src/store.ts` (+3/−0)

- `UserRecord.templateId?: string` — absent on pre-template records (backward compatible).
- `publicUser` exposes `templateId: u.templateId ?? "default"` — old rows surface as `default`.

#### `src/server.ts` (+29/−6)

- Loads the registry once at `createGateway` (`loadTemplateRegistry(opts.templateDir)`).
- Signup: passes `knownTemplates: templates.ids()` to validation; persists `templateId` on the new record; logs it; the JSON **202 response gains `templateId` + `templateName`** (the edge fn stores these).
- Provisioning: `startProvisioning` resolves `templates.get(user.templateId)` into the deps.
- `GET /health` gains `templates: templates.ids()` — live registry introspection.
- New `templateDir` option on `GatewayOptions`.

#### `src/provision.ts` (+73/−9) — where the template is applied

- **`upsertEnv`** — sets or overwrites an env var, recomputing `isSecret` from the key name.
- **`applyTemplateEnv`** — writes, in order: `TEMPLATE_ID`, `INSTINCT_PERSONA` (if present), `INSTINCT_INSTRUCTIONS` (if present), `INSTINCT_MODEL` (`provider/default`), then every template `env` entry. Applied **after** fleet defaults and `extraEnv`, so **template env wins** — including over the maritime-llm model default.
- **`maritimeCreateBody`** sizing:
  - `desktop` = `template.hardware.desktop` when a template is present, else the historic `deps.maritime.desktop ?? true` flag (no-template callers unchanged).
  - For a desktop-less template, sends `memMb: ramGb * 1024` and `vcpus: cpu` — sizing is only sent when `desktop` is false, because Maritime ignores it while a desktop forces its own 4 GiB / 2 vCPU.
  - JSDoc on `desktop` updated to document template ownership.
- **`pushTemplateSkills`** (new, called after agent creation) — `PUT /api/agents/{id}/files/write` per skill, body `{ path: "/data/skills/<name>/SKILL.md", content }`. **Best effort:** each write is wrapped in try/catch and only logs `provision.template_skill_failed` — a VM-still-deploying 503 never fails provisioning (the env seeds already took effect at create). The agent re-reads `/data/skills` every 30 s and on each prompt, so no restart is needed, and writes land on the persistent volume.
- `ProvisionDeps` / `AgentEnvDeps` gain optional `template?: GatewayTemplate`.

#### `src/main.ts` (+4/−0)

- `GatewayEnv.templatesDir?` read from `GATEWAY_TEMPLATES_DIR`; threaded through `startGateway` → `createGateway({ templateDir })`.

#### `package.json` (+1/−1)

- Added dependency `"yaml": "^2.8.0"` (parser for the registry format).

#### `pnpm-lock.yaml` (+3)

- Lockfile entry for `yaml@2.9.0`.

#### Tests

- **`test/templates.test.ts`** (new, 120 lines):
  - Shipped registry: exactly `["default", "gtm-ai"]`; `default` has no persona/skills and `{cpu:1, ramGb:4, desktop:false}`; `gtm-ai` carries persona, instructions, `gtm-playbook` skill content, model, `COMPOSIO_TOOLKITS`, and `{cpu:2, ramGb:4, desktop:false}`.
  - Loader rejection cases: missing `default.yaml`, name/file mismatch, bad semver, path-traversal persona, missing `SKILL.md`, non-scalar env value.
  - Acceptance case: a valid custom template with its own skill loads and resolves.
- **`test/validate.test.ts`** (+17/−4): exact-match assertion now includes `templateId: "default"`; new cases for known template pass-through, unknown template rejection, and traversal-shaped ids.
- **`test/provision.test.ts`** (+60/−0), `templates in provisioning` suite:
  - gtm-ai body: `desktop:false`, `memMb:4096`, `vcpus:2`, and env containing `TEMPLATE_ID`, `INSTINCT_PERSONA`, `INSTINCT_INSTRUCTIONS`, `INSTINCT_MODEL` (template beats the `gpt-9.9` maritime-llm model), `COMPOSIO_TOOLKITS`.
  - default body: `desktop:false`, `memMb:4096`, `vcpus:1`, `TEMPLATE_ID=default`, no `INSTINCT_PERSONA`, and **no `files/write` calls** (call sequence is exactly GET + POST).
  - Skills push: correct `PUT /api/agents/{id}/files/write` path, `/data/skills/gtm-playbook/SKILL.md`, content contains `Pain-Qualified`.
  - Failure path: a 503 on the skills write still yields `status: "ready"`.

---

## Request/response contract changes

### `POST /api/signup` (JSON)

Request (new optional field):

```json
{ "name": "...", "phone": "+1...", "handle": "...", "inviteCode": "...", "templateId": "gtm-ai" }
```

`templateId` accepts `template_id` as an alias; absent → `"default"`.

202 response (additive):

```json
{ "userId": "...", "connectUrl": "...", "status": "provisioning",
  "templateId": "gtm-ai", "templateName": "AI-native GTM" }
```

### `GET /health` (additive)

```json
{ "ok": true, ..., "templates": ["default", "gtm-ai"] }
```

### `GET /status` / `publicUser` (additive)

`"templateId": "gtm-ai"` (defaults to `"default"` for pre-template rows).

### Env vars

- **New:** `GATEWAY_TEMPLATES_DIR` — override the registry directory (default: the templates shipped inside the package; no Dockerfile change needed since `COPY packages` already carries them).

---

## Data-flow: signup → running agent

```
edge fn POST /api/signup { templateId }
        │
        ▼
validate.ts  ── format (TEMPLATE_ID_RE) ── membership (knownTemplates)
        │
        ▼
store.ts     ── UserRecord.templateId persisted (users.json)
        │
        ▼
server.ts    ── 202 { templateId, templateName }
        │
        ▼
provision.ts
   ├─ applyTemplateEnv  → TEMPLATE_ID, INSTINCT_PERSONA, INSTINCT_INSTRUCTIONS,
   │                      INSTINCT_MODEL, template env   (template wins)
   ├─ maritimeCreateBody → desktop:false, memMb, vcpus
   └─ pushTemplateSkills → PUT /files/write → /data/skills/<name>/SKILL.md
        │
        ▼
agent boots → seeds PERSONA.md / AGENTS.md from env (owner edits win later)
           → reads /data/skills every 30s
```

---

## Compatibility & failure modes

| Concern | Behavior |
|---|---|
| Pre-template user records | `templateId` absent → `publicUser` reports `"default"`; `templates.get(undefined)` falls back to `default`. |
| No template passed to provisioning | Historic behavior fully preserved: `desktop ?? true`, no template env, no skills push (covered by untouched existing tests). |
| Invalid registry at boot | `loadTemplateRegistry` throws → `createGateway` fails → gateway refuses to start with the exact offending message. |
| Unknown `templateId` at signup | 400 with `errors.templateId`, before anything is created. |
| Skills push fails | Logged as `provision.template_skill_failed`; user still reaches `ready`. |
| Template env vs fleet env | Template applied last — wins, including `INSTINCT_MODEL` over the maritime-llm default. |
| Persona/instructions vs owner edits | Env-seed semantics: `INSTINCT_INSTRUCTIONS` re-seeds until the owner edits AGENTS.md; owner edits always win. |
| Docker image | No Dockerfile change — `COPY packages ./packages` in the build stage already carries `packages/gateway/templates/` into the runtime image. |

---

## Verification

- **Tests:** 82/82 passing (`pnpm --filter @open-instinct/gateway test`) — 9 files, including 10 new template tests and 4 new provisioning tests.
- **Typecheck:** clean across the workspace (`pnpm run typecheck` — gateway, network, server, cli).
- **Live deployment:** gateway running at `https://gateway.foundersynergy.network` (OCI VM, `instinct-gateway` container) — `/health` reports `"templates":["default","gtm-ai"]`.
- **Secrets:** `yaml@^2.8.0` added with lockfile updated (`--frozen-lockfile` build verified on the VM).

---

## How to add a third template

1. Create `packages/gateway/templates/registry/<id>.yaml` (`api_version: instinct/v1`, `name` = `<id>`).
2. Optional: `templates/personas/<name>.md` and `templates/skills/<skill>/SKILL.md`.
3. Reference them: `template.persona: <name>`, `template.skills: [<skill>]`.
4. `pnpm --filter @open-instinct/gateway test` — add an assertion to `templates.test.ts`.
5. Ship: the registry rides in the image; `/health` lists the new id automatically; signup accepts it on next boot.

# Apps through Composio

Open Instinct reaches Gmail, Google Calendar, Google Contacts and, with
`COMPOSIO_TOOLKITS=all`, any of Composio's apps through Composio. This page explains
what Composio is, how to get a key, how the owner connects an app from a text
message, and what each tool is allowed to do.

Code: [`packages/apps`](../packages/apps/README.md). Server wiring: [`packages/server`](../packages/server/README.md).

(Open Instinct is unrelated to OpenInstinct, a separate project published by Merit Systems.)

## What Composio is

Composio is a hosted integration service. It stores the OAuth connection to a
person's apps. It then exposes the actions of those apps as tools.

Analogy: Composio is a keyring. The agent never holds the Gmail password. It holds
one key that opens the owner's Gmail door. The owner can take the key back at any
time.

The agent talks to Composio over MCP, the same protocol it uses for its desktop.
Each Composio tool becomes a Pi tool with a name like `app_gmail_send_email`.

## Getting an API key

1. Create an account at <https://app.composio.dev>.
2. Create a project. Copy the project API key.
3. Give the key to the agent as `COMPOSIO_API_KEY`.

The key is a deployer secret. The owner never sees it. Setting the key is what turns
apps on in the server.

| Where you run | How to set the key |
|---|---|
| `instinct dev` on your machine | Export `COMPOSIO_API_KEY` before `instinct init` and `instinct dev` |
| `instinct deploy` to Maritime | Export `COMPOSIO_API_KEY`; `deploy` copies it into the agent as a secret |
| Gateway, many users | Set `COMPOSIO_API_KEY` on the gateway; it passes the key to every agent it creates |
| Docker compose | Fill in `COMPOSIO_API_KEY` in [`deploy/.env.example`](../deploy/.env.example) |

One warning. `config.json` wins over the environment after the first boot, with
two exceptions operators use without editing state: `INSTINCT_MODEL` and
`COMPOSIO_TOOLKITS`. If you exported other settings after `init`, they may not
apply. `instinct dev` prints a warning in that case. Run
`instinct init --name <you> --apps` and start again.

## One session per person

A Composio session belongs to one user and one list of toolkits. Open Instinct
creates one session per agent, and one agent serves one owner. The user id is the
agent's Inkbox handle.

The session is saved in the state directory as `apps.json`:

```json
{ "sessionId": "...", "userId": "maria-instinct", "toolkits": ["gmail", "googlecalendar", "googlecontacts"], "mode": "direct", "createdAt": "..." }
```

The server reuses the saved session across restarts. It makes a new one when the user
id, the toolkit list or the mode changes, or when Composio no longer knows the saved
id. Deleting `apps.json` forces a fresh session on the next boot.

Google tokens live inside Composio, not on the agent. Nothing from Google is written
to disk in the agent.

## How the owner connects an app from a text

The owner never types a password into the chat. The whole flow is a link.

| Step | Who | What happens |
|---|---|---|
| 1 | deployer | Sets `COMPOSIO_API_KEY`. The server creates the session on boot. |
| 2 | agent | Its prompt says which apps are connected and which are not. |
| 3 | owner | Texts "connect my Gmail". |
| 4 | agent | Calls `apps_connect` for `gmail` and texts back the link. |
| 5 | owner | Opens the link on their phone, signs in with Google, approves the scopes. |
| 6 | Composio | Stores the tokens. The Gmail tools now work. |

The same text works for any app. What the owner can say, and what the agent does:

| Owner texts | Agent does |
|---|---|
| "which apps are connected?" | Calls `apps_list` and answers from it. |
| "connect my calendar" | `apps_connect googlecalendar`, sends the link. |
| "connect Notion" | `apps_connect notion`, sends the link. Needs `notion` in `COMPOSIO_TOOLKITS`, or `all`. |
| "hook up Slack" | `apps_connect slack`, sends the link. |
| "connect my GitHub" | `apps_connect github`, sends the link. |
| "disconnect Gmail" | `app_composio_manage_connections`, which revokes the connection. |

If an app is not in the toolkit list, `apps_connect` says so and names the fix:
add the slug to `COMPOSIO_TOOLKITS`, or set `COMPOSIO_TOOLKITS=all`. The slug is
the app's name in Composio's catalog, lowercase: `gmail`, `googlecalendar`,
`googlecontacts`, `notion`, `slack`, `github`, `linear`, `hubspot`, and so on.

Only the owner can connect or disconnect an app. `apps_connect` refuses every other
caller on its own, before the policy engine even looks. If a partner or a friend
asks, the agent declines and offers to tell the owner.

To disconnect, the owner can revoke access in the app's own account settings, or ask
the agent to disconnect, which calls `app_composio_manage_connections`.

## Tool families, capabilities and tiers

Every Composio tool carries a capability tag. The policy engine checks that tag
against the caller's tier before the tool runs. The tiers are described in
[PERMISSIONS.md](PERMISSIONS.md).

This is how a partner's Instinct can read the owner's calendar but cannot send
mail as the owner.

| Tool family | Capability | owner | partner | family | friend |
|---|---|---|---|---|---|
| `GMAIL_SEND_EMAIL`, `GMAIL_REPLY_TO_THREAD`, `GMAIL_CREATE_EMAIL_DRAFT`, `GMAIL_FORWARD*` | `email.send` | yes | ask | no | no |
| other `GMAIL_*` | `email.read` | yes | no | no | no |
| `GOOGLECALENDAR_CREATE*`, `UPDATE*`, `DELETE*`, `PATCH*`, `QUICK_ADD*` | `calendar.write` | yes | ask | ask | no |
| `GOOGLECALENDAR_FIND_FREE_SLOTS`, `FREEBUSY`, `GET_FREE_BUSY` | `calendar.freebusy` | yes | yes | yes | yes |
| other `GOOGLECALENDAR_*` | `calendar.read` | yes | yes | no | no |
| `GOOGLECONTACTS_CREATE*`, `UPDATE*`, `DELETE*`, `BATCH*`, `MODIFY*`, `ADD*`, `REMOVE*`, `PATCH*`, `COPY*` | `contacts.read` + `memory.write` | yes | no | no | no |
| other `GOOGLECONTACTS_*` | `contacts.read` | yes | partial | no | no |
| `COMPOSIO_MANAGE_CONNECTIONS`, `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MULTI_EXECUTE_TOOL` | `apps.use` + `trust.manage` | yes | no | no | no |
| `apps_list`, `apps_connect` | `apps.use` + `trust.manage` | yes | no | no | no |
| any other toolkit, read (`*_GET_*`, `*_LIST_*`, `*_SEARCH_*`, `*_FETCH_*`, ...) | `apps.use` + `trust.manage` | yes | no | no | no |
| any other toolkit, plain write (`NOTION_CREATE_PAGE`, `GITHUB_CREATE_ISSUE`, `LINEAR_UPDATE_ISSUE`, `GITHUB_DELETE_*`) | `apps.use` + `trust.manage` | yes | no | no | no |
| any other toolkit, send (`SLACK_SEND_MESSAGE`, `OUTLOOK_SEND_EMAIL`, `TWILIO_SEND_SMS`, `*_REPLY_*`, `*_FORWARD_*`) | `email.send` + `apps.use` + `trust.manage` | yes | no | no | no |
| any other toolkit, calendar write (`OUTLOOK_CALENDAR_CREATE_EVENT`, `ZOOM_CREATE_MEETING`, `CALENDLY_CANCEL_EVENT`) | `calendar.write` + `apps.use` + `trust.manage` | yes | no | no | no |
| any other toolkit, money (`STRIPE_CREATE_*`, `PAYPAL_*PAYOUT*`, `SHOPIFY_CREATE_ORDER`, `WISE_CREATE_TRANSFER`, `*_CHECKOUT_*`, `*_PAY*`, `*_CHARGE*`, `*_REFUND*`) | `purchase` + `apps.use` + `trust.manage` | ask | no | no | no |

Contacts and strangers get no app tools at all.

Notes on the table:

- `apps.use` is a transport tag. It says who may use Composio at all. The other
  tags on the same tool do the real gating.
- Rows with `trust.manage` are owner-only on purpose. `trust.manage` stands in for
  a future `apps.manage`. `memory.write` stands in for a future `contacts.write`.
  The constants `APPS_MANAGE` and `CONTACTS_WRITE` in
  [`packages/apps/src/capabilities.ts`](../packages/apps/src/capabilities.ts) are
  the one place to change when core adds those capabilities.
- A toolkit without its own row is judged by the words in the tool slug. Reads get
  no extra tag. A write that sends, changes a calendar or moves money gets the
  matching stricter tag on top of the owner-only pair. Every write in a payment
  toolkit (Stripe, PayPal, Square, Wise, Coinbase, Mercury, Brex, Ramp, ...) counts
  as money. The full word lists are in `sensitiveCapabilitiesForSlug`.
- The stricter tag matters in two places. A grant that names only `apps.use` and
  `trust.manage` opens Notion and GitHub for that person, but not Slack sends or
  Stripe charges. And `purchase` puts the owner's own call under the spend policy:
  the agent does not know the amount, so it asks the owner before any app action
  that moves money. Deletes in an unknown app are owner-only with no extra step.

A grant can widen a row for one person and a short time. See
[PERMISSIONS.md](PERMISSIONS.md#grants).

## Adding toolkits with COMPOSIO_TOOLKITS

`COMPOSIO_TOOLKITS` is a comma-separated list of Composio toolkit slugs, or the
word `all`. The default is `gmail,googlecalendar,googlecontacts`.

```bash
export COMPOSIO_API_KEY=...
export COMPOSIO_TOOLKITS=gmail,googlecalendar,googlecontacts,slack
instinct init --name "Maria" --toolkits gmail,googlecalendar,googlecontacts,slack
instinct dev
```

| Place | Effect |
|---|---|
| `instinct init --toolkits a,b` | Writes the list to `config.json` and turns apps on |
| `COMPOSIO_TOOLKITS` in env at first boot | Seeds `config.json` the same way |
| `instinct deploy` | Copies `COMPOSIO_TOOLKITS` (or the list from `config.json`) into the agent |
| Gateway | Sends `COMPOSIO_TOOLKITS` to every new agent, default list when unset |

`COMPOSIO_TOOLKITS` seeds `config.json` on an agent's first boot and keeps
winning after that: like `INSTINCT_MODEL`, the environment overrides the file on
every load, so changing the variable on a running agent (or on the gateway for
agents it already created) takes effect on the agent's next restart — the
gateway's admin reprovision endpoint does that for you. Existing OAuth
connections stay, because Composio stores them per user id, not per session.

Each toolkit needs an auth config in your Composio project. Some, such as Gmail and
Google Calendar, can use Composio's managed one; others, often Google Contacts in a
new project, need one you create under Auth Configs in the Composio dashboard. When the project lacks one, Composio
refuses the session for that toolkit. The agent then starts without it, keeps the
other apps, logs `composio: this Composio project has no auth config for ...`, and
tells the owner the app is not available yet. Add the auth config and restart the
agent to bring it in.

Toolkit slugs are lowercase. Find them in the Composio toolkit catalog, for example
`slack`, `notion`, `github`.

A toolkit outside Gmail, Calendar and Contacts has no row of its own in the
capability table. Its tools are owner-only, with a stricter tag when the slug
sends, changes a calendar or moves money (table above). That is the safe default.

Changing the list makes a new Composio session on the next boot. Existing OAuth
connections stay, because Composio stores them per user id, not per session.

## Session mode: COMPOSIO_MODE

| `COMPOSIO_MODE` | What the model sees | Who may use apps |
|---|---|---|
| `direct` | One tool per app action (`app_gmail_send_email`, ...) | By tool, per tier: a partner can read your calendar |
| `router` | Composio's meta tools only: search, multi-execute, manage connections | Owner only |
| unset | `router` when the model speaks an OpenAI-style chat completions API, `direct` otherwise | As above |

OpenAI-style chat completions APIs reject a request with more than 128 tools
(`Invalid 'tools': array too long`). The Maritime LLM proxy that `instinct deploy
--maritime-llm` and the gateway's `INSTINCT_USE_MARITIME_LLM=1` use is one of them,
and so is any `openai-compatible/<model>`. Direct Gmail plus Calendar alone is about a
hundred tools, and the agent has a few dozen of its own, so on those models a direct
session would make every reply fail. Left unset, the mode is chosen from the model;
the boot log says which (`apps: composio router mode (...)`). Set `COMPOSIO_MODE=direct`
only with a short toolkit list; the agent logs a warning at boot when the total
passes 128 on such a model.

## Every app: COMPOSIO_TOOLKITS=all

```bash
export COMPOSIO_API_KEY=...
export COMPOSIO_TOOLKITS=all
instinct init --name "Maria" --toolkits all
instinct dev
```

`all` (or `*`) creates the Composio session without a toolkit allowlist. The owner
can then say "connect Notion" or "hook up Linear" and the agent connects it, with
no redeploy. `apps.json` records `"toolkits": ["*"]`.

What changes in this mode:

| | Explicit list | `all` |
|---|---|---|
| Session | `direct_tools` preset, one MCP tool per app action | Router: `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MULTI_EXECUTE_TOOL`, `COMPOSIO_MANAGE_CONNECTIONS` |
| How the model acts | Calls `app_gmail_send_email` directly | Searches for the action, then runs it through multi-execute |
| Who may act | By tool: partner reads the calendar, friend checks free/busy | Owner only. The meta tools cost `apps.use` + `trust.manage` |
| Connected apps on boot | Each configured toolkit, connected or not | Every toolkit with an active connection |
| New app | Deployer adds the slug and restarts | Owner texts "connect X" |

Composio cannot list every tool of every app directly, so `all` always runs in
router mode even when `mode: "direct"` is set; the log says so. The trade is
explicit: in `all` mode nobody but the owner can use apps, because the guard sees
one multi-execute call and cannot tell a calendar read from a Stripe charge.
Choose the explicit list when a partner's or a friend's agent should reach your
calendar; choose `all` when you want every app at your fingertips and apps are
yours alone.

`apps_connect` works the same in both modes. In `all` mode any slug is accepted.
`apps_list` shows the apps that hold a live connection.

## Limits

| Limit | Detail |
|---|---|
| Owner connects apps | No other tier can connect, disconnect or manage connections. |
| Unknown toolkits are owner-only | Add a row to `capabilities.ts` to open one to other tiers. Sends, calendar writes and money moves in unknown toolkits carry a stricter tag as well. |
| `all` mode is owner-only | Without an allowlist the session holds only the meta tools, so every app call is `apps.use` + `trust.manage`. |
| Money moves ask | An app action tagged `purchase` has no known amount, so the spend policy asks the owner first. |
| Multi-execute cannot be checked per tool | `COMPOSIO_MULTI_EXECUTE_TOOL` runs several tools in one call. The guard sees one capability. The default `direct` session mode leaves this tool out and lists each app action on its own. |
| 128 tools on OpenAI-style APIs | Chat completions APIs, the Maritime LLM proxy among them, cap a request at 128 tools. `COMPOSIO_MODE` defaults to `router` on those models. |
| `router` mode is owner-only | In `router` mode the session holds only the meta tools, so every call costs `apps.use` + `trust.manage`. Choose it only for a toolkit list too large to list directly. |
| Email and calendar content is data | The prompt tells the model that text inside an email or event is not an instruction. |
| No tokens in chat | The model is told never to paste tokens, API keys or OAuth codes into a message. Links are fine. |
| Composio pricing | Composio-managed OAuth apps have a free call quota, then a per-call fee. Check <https://composio.dev/pricing>. |
| Google verification | `gmail.send` with your own OAuth client needs Google verification. Composio-managed auth avoids this for development. |
| Node version | `@composio/core` 0.22.0 declares Node `>=22.22.3`. It runs on 22.20.0; pnpm may print a warning. |

## Checking that it works

```bash
instinct status
```

The status line lists the connected apps, as does `apps: [...]` on the server's
`/status` page. The server log at boot prints
`apps: <n> tools, connected: gmail, googlecalendar` or `connected: none`, with
`(any app by name)` added in `all` mode.

Then text the agent: "what's on my calendar tomorrow". The model calls
`app_googlecalendar_events_list`. The guard checks `calendar.read`. The owner has it.
The reply comes back on iMessage.

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md): where apps sit in the agent
- [PERMISSIONS.md](PERMISSIONS.md): tiers, capabilities, grants
- [PAYMENTS.md](PAYMENTS.md): the Stripe Link wallet, a separate rail from Composio
- [`packages/apps/README.md`](../packages/apps/README.md): API and tests

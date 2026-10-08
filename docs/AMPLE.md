# Ample

[Ample](https://ample.computer) lets the agent put the websites and small apps
it builds online. The owner texts "make a page for Maya's birthday with an RSVP
form", the agent writes it in its workspace, deploys it and texts back a public
HTTPS link. Ask for a change and it redeploys to the same link.

`@open-instinct/ample` adds four tools, present only when an Ample credential
is set:

| Tool | What it does |
|---|---|
| `ample_deploy` | Deploys a folder inside `workspace/` to a public URL: one app, or a project of several services. Ample detects the framework (static, Node, Python, Go, Ruby, PHP and more), builds it, and returns when it is live or failed |
| `ample_logs` | Build or runtime logs for a deployment |
| `ample_apps` | The apps deployed so far, with their URLs |
| `ample_app_delete` | Takes an app offline |

The `web-apps` skill tells the agent when to use them and how to build an app
that deploys cleanly.

## Setup

There are two ways to give the agent an Ample account.

### Its own account (`AMPLE_SIGNUP=1`)

```bash
export AMPLE_SIGNUP=1
pnpm instinct dev
```

No key is needed. The first time the owner asks for a site, the agent signs up
for a free Ample account of its own, deploys into it, and sends the owner the
site's link together with a claim link. Opening the claim link and confirming
an email makes the owner the account's owner. When the owner's email is in the
config (`INSTINCT_OWNER_EMAIL`), Ample also emails them a claim link at signup.

Ample deletes an unclaimed account, with its sites, two days after signup.
Until the owner claims it, every deploy result reminds the agent of the claim
link. If the account was deleted, the next deploy signs up again, tells the
owner the old sites are gone, and redeploys from the workspace, where the
app's files still are. The account's credential lives in
`<data>/secrets/ample.json` (0600), next to the Link wallet's tokens.

This is the mode for the gateway: set `AMPLE_SIGNUP=1` on the gateway and it
passes the switch, never a credential, to every agent it provisions. Each
person's agent then has an account nobody else can see.

### A shared credential

Get an agent credential. Either sign up a new Ample account from the command
line (no browser needed):

```bash
curl -fsSL https://get.ample.computer/install.sh | sh
ample --format json auth signup --name my-instinct
```

The response has `credentials.client_id`, `credentials.client_secret` and a
`claim_url`. Open the claim URL to keep the account: unclaimed accounts expire
after 48 hours. Or, with an account you already have:

```bash
ample auth agent create --name instinct --scope 'servers:read,servers:write,databases:*'
```

Then export both values before starting or deploying the agent:

```bash
export AMPLE_CLIENT_ID=agent_...
export AMPLE_CLIENT_SECRET=ample_agent_...
pnpm instinct dev
```

`instinct deploy` forwards them to Maritime, the secret as an encrypted
variable. `AMPLE_TOKEN` (an API token) works instead of the pair until the
token expires; the pair lasts until you revoke it with
`ample auth agent revoke`. `AMPLE_API_URL` points at another Ample API and
`AMPLE_BIN` at another CLI binary. A credential wins over `AMPLE_SIGNUP`.

The gateway never forwards a credential to the agents it provisions (it logs a
warning if one is set): every agent with the same credential would deploy into
the same Ample account and could list or delete each other's apps. Use
`AMPLE_SIGNUP=1` there.

## How it works

The tools drive the `ample` CLI, which the agent image installs (a static
binary, pinned and checksummed in `deploy/Dockerfile.agent`). On a laptop,
install it with the command above.

`ample_deploy` first asks Ample's planner what the folder holds. A single app
at the folder's root deploys under the folder's name (`ample deploy --name`),
which keeps its URL short. Anything else (several services, or one app in a
subfolder) is written to an `ample.toml` plan in the folder and deployed as a
project, every service in dependency order with one URL per public service.
Questions the planner cannot answer from the code come back to the agent,
which answers them with `answers` (`ample plan --answer`). Secrets go to the
CLI in a dotenv file outside the workspace, removed after the run.

The CLI owns packaging and the deploy contract: it blocks until the release is live (exit 0), failed (exit 1) or
needs a decision (exit 2), and a redeploy with no changes returns the live URL
without rebuilding. A failed deploy says who has to act (`owner: app` means the
code), what went wrong, and a suggested fix, which the agent uses to fix its
code and deploy again.

Apps sleep when idle and wake on the next request. An app that reads
`DATABASE_URL` gets a managed Postgres database. Plan limits and pricing are
at [ample.computer/pricing](https://ample.computer/pricing).

## Safety

- Owner only. Every tool needs `files.read`, and `ample_deploy` and
  `ample_app_delete` also need `files.write`, so by default no contact or
  stranger can trigger a deploy, and a grant has to say so explicitly.
- Workspace only. `ample_deploy` packages a folder inside `workspace/` and
  refuses the workspace itself, so the owner's other files never ship. The CLI
  skips symlinks, so a link in the folder cannot pull in files from outside.
- The credential never reaches the model. The agent exchanges it for a
  15-minute access token and hands that only to the `ample`
  process it spawns, whose environment is otherwise empty apart from `PATH`
  and `HOME`. The CLI is pointed at an empty config file, so a config written
  from the shell cannot redirect it.
- One account per person. With `AMPLE_SIGNUP=1` every agent has its own
  account, so no agent can see or change another person's sites. A shared
  credential is for one person or a team that means to share.
- The env credential is never in the `bash` tool's environment. A signed-up
  account's file is under `<data>/secrets`, like the Link wallet's tokens:
  the shell runs as the same user and can read it, so the same rule applies
  (only the owner's conversation has the shell).
- The claim link controls the account until someone claims it. The agent only
  sends it to the owner.
- CLI output can quote build logs and app output, so it reaches the model
  wrapped as untrusted data.

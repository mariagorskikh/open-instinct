# Keys you need, and how to get them

Open Instinct is glue between four services and one model provider. You bring your own
accounts. Nothing in this repository contains a key, and nothing you add should either:
keys live in your shell environment or in `.instinct/secrets/` (mode 0600, ignored by git).

Analogy: the repo is the house plan. The keys to the front door, the phone line and the
bank are yours to hand over at move-in.

## Table of contents

1. [What you need for each setup](#1-what-you-need-for-each-setup)
2. [Anthropic (the model)](#2-anthropic-the-model)
3. [Inkbox (iMessage, phone, email, agent-to-agent)](#3-inkbox-imessage-phone-email-agent-to-agent)
4. [Maritime (hosting and the desktop)](#4-maritime-hosting-and-the-desktop)
5. [Composio (Gmail, Calendar and 1000+ apps)](#5-composio-gmail-calendar-and-1000-apps)
6. [Stripe Link (payments)](#6-stripe-link-payments)
7. [Optional keys](#7-optional-keys)
8. [Where keys live, and what never goes in git](#8-where-keys-live-and-what-never-goes-in-git)
9. [Using other providers](#9-using-other-providers)

## 1. What you need for each setup

| Setup | Required | Optional |
|---|---|---|
| Try it on your laptop, no phone | `ANTHROPIC_API_KEY` (or another model key) | `COMPOSIO_API_KEY`, `BRAVE_SEARCH_API_KEY` |
| Give it an iMessage line | the above plus `INKBOX_ADMIN_API_KEY` | `LINK_*` for payments |
| Run it on Maritime for one person | the above plus `MARITIME_API_KEY` | same |
| Run it for many people (gateway) | all of the above plus `GATEWAY_SIGNUP_SECRET` | `LINK_*` |

Rough monthly cost for one active person, as of October 2026: the model is the biggest
line (a few dollars a day of heavy use on Fable 5.1, far less on Sonnet 5.5); Inkbox has a
paid plan for iMessage lines; Maritime bills the microVM by the hour it is awake (a sleeping
agent costs nothing); Composio and Stripe Link have free tiers for this scale.

## 2. Anthropic (the model)

Variable: `ANTHROPIC_API_KEY`

1. Go to [console.anthropic.com](https://console.anthropic.com), sign in, open **API keys**.
2. Create a key and copy it once.
3. `export ANTHROPIC_API_KEY=sk-ant-...`

The default model is `anthropic/claude-fable-5-1`. Change it with `INSTINCT_MODEL`, for
example `anthropic/claude-sonnet-5-5` for a cheaper agent, or any provider in Pi's catalog
(`openai/gpt-...`, `google/gemini-...`, `groq/...`). Each provider reads its usual variable
(`OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`). For an OpenAI-compatible proxy set
`INSTINCT_MODEL=openai-compatible/<model>` plus `OPENAI_BASE_URL` and `OPENAI_API_KEY`.

## 3. Inkbox (iMessage, phone, email, agent-to-agent)

Variables: `INKBOX_ADMIN_API_KEY` (your org key, used once to provision), then per agent
`INKBOX_API_KEY`, `INKBOX_AGENT_HANDLE`, `INKBOX_IDENTITY_ID`, `INKBOX_SIGNING_KEY`
(the CLI writes these for you).

1. Create an account at [inkbox.ai](https://inkbox.ai) and open the **Console**.
2. Pick a plan that includes iMessage. Identities, numbers and iMessage lines are plan limited.
3. **API keys**: create an organization (admin) key. Copy it once.
4. `export INKBOX_ADMIN_API_KEY=ApiKey_...`
5. `pnpm instinct init --name ... --phone ... --email ... --handle <your-handle>`
   creates the identity with iMessage enabled, mints an identity-scoped key, creates the
   webhook signing key, and saves them to `.instinct/secrets/inkbox.json`.
6. `pnpm instinct connect` prints the router number and the exact text to send
   (`connect @<your-handle>`).

Keep the admin key on your machine or in the gateway only. Agents get identity-scoped keys,
which can send and read for one identity and nothing else.

No organization yet? Inkbox also offers agent self-signup, where the agent registers itself
and a human approves by email. See [INKBOX.md](INKBOX.md).

## 4. Maritime (hosting and the desktop)

Variable: `MARITIME_API_KEY`

1. Create an account at [maritime.sh](https://maritime.sh).
2. Open **Settings**, then **API keys**. Create a key with the scopes `provision`, `deploy`
   and `secrets` (add `manage` only for a key that should also delete agents and mint keys;
   add `computers` if you want the hosted desktop MCP from outside a VM).
3. `export MARITIME_API_KEY=mk_...`
4. `pnpm instinct deploy --image ghcr.io/mariagorskikh/open-instinct-agent:latest`

Creating an agent debits your Maritime wallet; a sleeping agent costs nothing. The image is
public and needs no registry login. See [DEPLOY-MARITIME.md](DEPLOY-MARITIME.md).

## 5. Composio (Gmail, Calendar and 1000+ apps)

Variable: `COMPOSIO_API_KEY`, optional `COMPOSIO_TOOLKITS` (default `gmail,googlecalendar,googlecontacts`)

1. Create an account at [composio.dev](https://composio.dev) and open the dashboard.
2. **Settings**, then **API keys**. Copy the key.
3. `export COMPOSIO_API_KEY=...`

The agent creates one Composio session per person. The person connects their own Google
account from a link the agent texts them; your key never sees their mailbox password. See
[COMPOSIO.md](COMPOSIO.md).

## 6. Stripe Link (payments)

Variables: `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET`, `STRIPE_PUBLISHABLE_KEY`, optional `LINK_REDIRECT_URI`

1. Have a [Stripe account](https://dashboard.stripe.com/register). Your customers must be
   US or Canadian consumers; your business can be anywhere.
2. Apply for a Link Agent Wallet OAuth client through the form linked from the
   [Link Agent Wallet OAuth docs](https://docs.stripe.com/agentic-commerce/agents/link-agent-wallet/oauth).
   Give the exact redirect URIs you will use (`https://<your-gateway>/oauth/link/callback/<userId>`
   for the gateway, or `http://127.0.0.1:8080/oauth/link/callback` for a laptop).
3. Stripe sends a `client_id` and `client_secret`. Your publishable key is in the Stripe dashboard.
4. Export the three variables. The owner connects their wallet from a link the agent texts,
   and approves each purchase in the Link app.

See [PAYMENTS.md](PAYMENTS.md). Without these variables the agent still shops; it hands you
the screen at checkout instead of paying.

## 7. Optional keys

| Variable | What it unlocks | Where |
|---|---|---|
| `BRAVE_SEARCH_API_KEY` | Better web search than the DuckDuckGo fallback | [brave.com/search/api](https://brave.com/search/api/) |
| `CONTEXT_DEV_API_KEY` | Sourced answers and public page research through `context_answers` | [context.dev](https://context.dev) |
| `AMPLE_CLIENT_ID`, `AMPLE_CLIENT_SECRET` | Web apps the agent builds, deployed to public URLs through `ample_deploy` ([AMPLE.md](AMPLE.md)) | [ample.computer](https://ample.computer), `ample auth signup` |
| `INSTINCT_CHAT_TOKEN` | A bearer token on the owner's HTTP surface; set it whenever the port is reachable beyond your machine | you choose it |
| `GATEWAY_SIGNUP_SECRET` | The invite code the gateway's signup form requires | you choose it |

## 8. Where keys live, and what never goes in git

- Shell environment, or `deploy/.env` copied from [`deploy/.env.example`](../deploy/.env.example). `.env` is in `.gitignore`.
- `.instinct/secrets/*.json`, written by the CLI with mode 0600. The whole `.instinct/` folder is in `.gitignore`.
- On Maritime, as encrypted agent environment variables. On the gateway, in its data directory.
- Never in a prompt, a skill file, a log line or a test fixture. The repo runs
  [gitleaks](../.github/workflows/secret-scan.yml) on every push with rules for each key format
  in [`.gitleaks.toml`](../.gitleaks.toml).

If a key ever lands in a commit, treat it as leaked: revoke it at the provider first, then
rewrite history.

## 9. Using other providers

Every external service sits behind one small package, so swapping is a pull request, not a
rewrite:

| Want to replace | Implement | Example |
|---|---|---|
| The model | nothing; pick any Pi provider with `INSTINCT_MODEL` | `openai/gpt-5`, `google/gemini-3-pro` |
| iMessage, SMS or email | `Outbox` plus a `parse<Channel>Event()` in a new package | Twilio, WhatsApp Cloud API, Telegram |
| The computer | a `ComputerBackend` (any MCP server works) | Browserbase, Kernel, a local Playwright |
| Apps | any MCP server; map tools to capabilities like `packages/apps` does | Zapier MCP, your own servers |
| Hosting | any host that runs the container and calls `/chat` | Fly, Railway, a Raspberry Pi |
| Payments | a `paymentsTools()` with the same four tools | Privacy.com, Stripe Issuing |

Read [CONTRIBUTING.md](../CONTRIBUTING.md) for the rules of the house, open a draft PR early,
and keep the capability tags honest so the trust tiers keep meaning what they say.

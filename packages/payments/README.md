# @open-instinct/payments

The agent's wallet. This package connects an Open Instinct agent to the owner's Stripe Link
account through Link Agent Wallet, the same rail Instinct uses, and exposes four tools:
`payment_connect`, `payment_request`, `payment_status`, `payment_list`.

(Open Instinct is unrelated to OpenInstinct, a separate project published by Merit Systems.)

## What Link Agent Wallet is

Link is Stripe's consumer wallet. Link Agent Wallet lets a consumer authorize an agent to spend
from it, one purchase at a time. The agent never holds the owner's card. It creates a *spend
request* for an exact amount and merchant, Link shows the owner an approval screen, and after
the owner taps approve Link mints a one-time virtual card for that amount. The agent types that
card into the merchant's checkout like a person would. The card works once.

Analogy: the owner keeps the wallet. The agent asks for exact change, in writing, and gets a
single bill that only works at the shop it named.

The agent business does not need a Stripe account. The owner needs a Link account with a card
or bank account on it. Link Agent Wallet is available to consumers in the United States and
Canada; the agent itself can run anywhere.

## How it fits

```
owner: "buy the socks in my Acme cart"
  -> model gets the checkout to a final total ($25.99)
  -> payment_request { amountUsd: 25.99, merchantName: "Acme", context: "..." }
       policy guard: purchase capability, owner spend limits (ask above $50 by default)
       Link: paymentMethods.list -> spendRequests.create -> requestApproval
       iMessage to owner: "Approve $25.99 to Acme? https://link.com/... Expires in 10 minutes."
       payments.json: { spendRequestId, amountUsd, merchantName, status: pending_approval }
       audit.jsonl: { kind: "spend", amountUsd: 25.99 }  (the hold, logged by the runtime)
  -> model tells the requester it is waiting and ends its turn
owner taps approve in Link, texts "approved"
  -> payment_status { spendRequestId }
       Link: spendRequests.retrieve(id, { include: ["card"] }) -> status approved + card
       tool result: card number, expiry, CVC, billing address, shown once
       payments.json: cardDelivered true; audit.jsonl: { kind: "spend", deliveredUsd: 25.99 }
  -> model types the card into the checkout on its desktop
  -> payment_status again returns only "approved, already delivered"
```

## Registering an OAuth client

Link Agent Wallet uses OAuth 2.0 with PKCE. You need a client id, a client secret and a Stripe
publishable key.

1. Read the Stripe guide: <https://docs.stripe.com/agentic-commerce/agents/link-agent-wallet/oauth>.
2. Request a client through the Google form linked from that page. Give your app name, a short
   description of what the agent buys, and the exact redirect URI(s) your deployment will use.
3. Redirect URIs must match exactly, including scheme, host, port and path. The server's default
   is `<INSTINCT_PUBLIC_URL>/oauth/link/callback`. For `instinct dev` it is
   `http://127.0.0.1:<port>/oauth/link/callback`. Register every variant you will use.
4. Stripe sends back `client_id` and `client_secret`. The publishable key (`pk_live_...` or
   `pk_test_...`) comes from your Stripe Dashboard under Developers, API keys.

Scopes requested: `payment_methods.agentic userinfo:read`. Access tokens last 3600 seconds.
Refresh tokens rotate on every refresh. Authorization codes expire after 10 minutes.

## Environment variables

Read by the server, never by this package. The server passes them into `LinkWallet`.

| Variable | What it is |
|---|---|
| `LINK_CLIENT_ID` | OAuth client id from Stripe |
| `LINK_CLIENT_SECRET` | OAuth client secret from Stripe |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key; sent as the bearer on token calls and as `key` on the authorize URL |
| `LINK_REDIRECT_URI` | Optional. Overrides the computed callback URL. Must match a registered URI exactly |

When all three required variables are set and this package is installed, the server builds a
`LinkWallet`, registers the tools and serves the callback at `/oauth/link/callback`.

## The owner flow in three texts

1. **Connect.** Owner: "connect my wallet". The agent calls `payment_connect` and texts back a
   `login.link.com` link. The owner signs in to Link and approves the connection. Tokens land in
   `<state>/secrets/link-tokens.json`. Nothing is typed into the chat.
2. **Approve.** Later, the agent reaches a checkout and calls `payment_request`. The owner gets
   one text: "Approve $25.99 to Acme? <link> Expires in 10 minutes." They tap it and approve in
   Link.
3. **Done.** The owner texts "approved" (or the agent is asked to check). The agent calls
   `payment_status`, receives the one-time card once, types it into the checkout and reports the
   confirmation number. The card details never appear in a message.

## Usage

```ts
import { LinkWallet, paymentsTools, paymentsGuidance } from "@open-instinct/payments";

const wallet = new LinkWallet({
  state,                                   // core StateDir
  clientId: env.LINK_CLIENT_ID,
  clientSecret: env.LINK_CLIENT_SECRET,
  publishableKey: env.STRIPE_PUBLISHABLE_KEY,
  redirectUri: `${publicUrl}/oauth/link/callback`,
});

registry.registerMany(paymentsTools({ wallet, outbox, config, audit, state }));
promptSections.push(paymentsGuidance(wallet.isConnected()));

// In the HTTP server, on GET /oauth/link/callback?code=...&state=...
await wallet.handleCallback(code, state);

// Owner says "disconnect my wallet"
await wallet.revoke();
```

### API

| Member | What it does |
|---|---|
| `new LinkWallet(opts)` | `{ state, clientId, clientSecret, publishableKey, redirectUri, fetchImpl?, now?, linkFactory? }`. Throws when a credential is empty. |
| `authorizeUrl()` | Generates a PKCE verifier and a state, writes them to `secrets/link-oauth.json` (mode 0600), returns `{ url, state }`. |
| `handleCallback(code, state)` | Rejects a missing or mismatched state and a flow older than 10 minutes. Exchanges the code, writes `secrets/link-tokens.json` (0600), removes the pending file. |
| `isConnected()` | True when a complete token file exists. |
| `client()` | A Link SDK client (cached). Its `getAccessToken` returns the stored token while it has more than 5 minutes left, otherwise refreshes. Concurrent refreshes share one request. The rotated refresh token is written before the new access token is returned. A rejected refresh token (`invalid_grant`) clears the file. |
| `getAccessToken({ forceRefresh? })` | The provider behind `client()`, exposed for hosts that build their own SDK client. |
| `revoke()` | Revokes the refresh token at Link, then deletes the local token file even if Link was unreachable. |
| `paymentsTools(deps)` | `{ wallet, outbox, config, audit, state }` to the four `RegisteredTool`s. |
| `paymentsGuidance(connected)` | Prompt section explaining the flow and the card rules to the model. |

Lower-level pieces are exported too: `buildAuthorizeUrl`, `challengeS256`, `generateVerifier`,
`exchangeCode`, `refreshTokens`, `revokeToken`, `buildContext`, `toCents`, `readPayments`.

### Tools

Every tool has `meta: { capabilities: ["purchase"], group: "apps" }`. The runtime logs
`payment_request`'s amount as a spend when it runs, which holds it against the daily total.
`payment_connect`, `payment_status` and `payment_list` set `recordsOwnSpend: true` so the
runtime adds no empty spend entries for them. The policy engine in core
gives the owner `limit` on `purchase` (per-action, per-day and ask-above thresholds), `ask` to
partners, and `no` to everyone else unless a grant says otherwise.

| Tool | Args | Behavior |
|---|---|---|
| `payment_connect` | none | Owner only. Builds the authorize URL and texts it to `config.owner.phones[0]`. |
| `payment_request` | `amountUsd`, `merchantName`, `merchantUrl?`, `context`, `idempotencyKey?` | `meta.amountUsd` is the dollar amount, so spend limits apply. Lists payment methods, picks the default (else the first), creates the spend request with `credential_type: "card"` in USD minor units, calls `requestApproval`, records the request in `payments.json`, texts the owner the approval URL. Returns the id and "waiting for approval". |
| `payment_status` | `spendRequestId` | Only ids made by `payment_request`. Retrieves with `include: ["card"]` until the card has been delivered. On the first `approved` with a card: returns number, expiry, CVC and billing address once, marks the record delivered, appends a `spend` audit entry with `deliveredUsd` (no second amount). On the first `denied`, `expired`, `canceled` or `failed`, appends a negative `amountUsd` the same day to release the hold. Later calls return the status only. Other statuses return one line, including the owner action for `requires_action`. |
| `payment_list` | none | Owner only. The 20 most recent records, newest first, no card data. |

`context` is what the owner reads on the Link approval screen. Link requires at least 100
characters. The tool builds it as "<agent>, <owner>'s agent, is buying from <merchant> for
<amount>. Reason: <the model's context>. Requested by <who> over iMessage at <time>." and pads
if that is still short.

## State on disk

```
secrets/link-oauth.json    pending PKCE verifier and state (0600, deleted after the callback)
secrets/link-tokens.json   access token, refresh token, expiry (0600)
payments.json              { version: 1, requests: [{ spendRequestId, amountUsd, merchantName, createdAt, status, requestedBy, cardDelivered, ... }] }
```

`payments.json` never holds card data or approval URLs. Deleting `secrets/link-tokens.json`
disconnects the wallet locally; `revoke()` also tells Link.

## Limits

- Link Agent Wallet serves consumers in the United States and Canada. Owners elsewhere cannot
  connect yet.
- The owner's Link account carries its own per-transaction, daily and 30-day limits
  (`link.userInfo.retrieve()` reports them). Link may also require identity verification before
  the first purchase; `payment_status` surfaces that as a `requires_action` message for the owner.
- Approval links expire after 10 minutes. The one-time card is valid for a short window after
  approval and for the approved amount only.
- Amounts are USD. The tool rejects anything below $0.01 or above $100,000 and rounds to cents.
- One card per spend request. If a checkout fails, the agent makes a new request; the owner
  approves again.
- Core's spend policy matches merchants on args named `merchant`, `vendor`, `store` and so on.
  The `merchantName` arg here is not matched by the allowed and blocked merchant lists yet.

## Security notes

- Card data appears exactly once, in the tool result that first sees an approved request. It is
  never written to `payments.json`, `audit.jsonl`, the journal or any message. The result text
  tells the model the same thing.
- Secrets are written to `secrets/` with mode 0600 through a temp file and rename. The verifier
  and client secret never appear in a URL or a message. Only the login link does.
- The OAuth `state` is random and checked on the callback. A callback with no pending flow, a
  wrong state, or a flow older than 10 minutes is rejected.
- Refresh tokens rotate. The new one is persisted before the access token is handed to the SDK,
  so a crash between the two cannot strand the wallet on a dead token.
- `payment_connect` and `payment_list` run for the owner only, whatever the policy says.
  `payment_request` and `payment_status` run for anyone the policy allows, which by default means
  the owner, or a partner after the owner approves each one.
- Pages and emails the agent reads while shopping are data. The guidance section tells the model
  not to change an amount or merchant because a page asked it to. The owner sees the exact amount
  and merchant in Link before any card exists.
- This package reads no environment variables and performs no network calls except to
  `login.link.com` (OAuth) and, through the SDK, `api.link.com`.

## Testing

```
pnpm --filter @open-instinct/payments test
```

Tests cover the PKCE helpers (verifier length and alphabet, the RFC 7636 S256 vector), the
authorize URL shape, the callback with a fake fetch (state mismatch, expiry, token exchange body,
0600 file mode), refresh-ahead logic with a fake clock (fresh token served from disk, refresh at
five minutes, forced refresh, coalesced concurrent refreshes, rotated refresh token persisted,
`invalid_grant` clears the file), revoke, and the full tool flow against a stubbed Link client
injected through `linkFactory` (default payment method, create and approval params, context
length, payments.json record, owner text, card delivered once, spend audit entry, owner-only
tools). No network calls.

## Notes for implementers

- `@stripe/link-sdk` 0.11.0 ships declaration files that import through a `@/` alias and
  extensionless relative paths, so under NodeNext most of its types resolve to `any`. The shapes
  this package reads are mirrored in `src/link-types.ts` (`LinkClientLike`, `SpendRequest`,
  `Card`, `PaymentMethod`). `wallet.client()` returns a real `Link` instance typed as
  `LinkClientLike`.
- The SDK retries a request once with `getAccessToken({ forceRefresh: true })` after a 401. The
  wallet handles that path the same way as a scheduled refresh.
- The SDK's `test: true` flag on spend requests routes to Link's test mode (test card
  `4000009990001984`). It is not exposed as a tool argument; add it in a test build if needed.

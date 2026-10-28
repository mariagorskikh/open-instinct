# @open-instinct/inkbox

The Inkbox adapter. Inkbox is the phone company for Open Instinct: it gives the
agent a handle, a mailbox, an iMessage line, an optional SMS number, and an
agent-to-agent (A2A) endpoint. This package provides the pieces
the rest of the system uses:

| Piece | What it does |
|---|---|
| `InkboxProvisioner` | Admin-key operations: create an identity, mint its own API key, create the webhook signing key, subscribe webhooks, read the iMessage router, enable A2A, allow peers, create invitations |
| `parseInkboxEvent` + `verifyInkboxSignature` | Turn a signed webhook into one `InboundMessage` the runtime understands |
| `InkboxInboundHydrator` | Resolve conversation membership, fetch complete email content, and download inbound attachments |
| `DurableInbox` | Persist webhook receipts before acknowledging, then process and retry queued work |
| `InkboxChannel` | The `Outbox`: send iMessage, SMS, email and A2A replies, plus typing, tapbacks and read receipts; `sendFile` attaches a file (iMessage and SMS through the media upload, email as an attachment) |
| `InkboxA2A` + `messagingTools` | A2A worker and caller over REST and JSON-RPC, and the `send_message`, `send_typing`, `react`, `send_file` tools the model calls |

The server supplies state-file and workspace paths for receipts and downloaded attachments.
Every REST call this package makes itself goes through `fetchImpl ?? globalThis.fetch`.
Sends go through the official `@inkbox/sdk` so request shapes track the API.

## Identities

One Inkbox identity is one agent. It has:

- a **handle** (`maria-instinct`), used in `connect @maria-instinct`, in A2A URLs and in contact rules;
- a **mailbox** (`maria-instinct@inkboxmail.com`) created with the identity;
- **iMessage** on the shared router line when `imessage_enabled: true`, or a dedicated line when claimed;
- an optional **phone number** for SMS (`phone: true`), subject to inventory;
- an **A2A endpoint** at `https://inkbox.ai/a2a/{handle}` once enabled.

Two kinds of API key matter:

- the **admin key** is org-wide. The gateway or the CLI uses it once per user to provision;
- an **identity-scoped key** sees one identity only. The agent process runs with this key.

```ts
import { InkboxProvisioner } from "@open-instinct/inkbox";

const admin = new InkboxProvisioner({ adminApiKey: process.env.INKBOX_ADMIN_API_KEY! });
const id = await admin.provisionIdentity({ handle: "maria-instinct", displayName: "Maria's Instinct", imessage: true });
const agentKey = await admin.mintIdentityKey(id.identityId, "maria agent");      // shown once
const signingKey = await admin.ensureSigningKey(id.handle);                    // store immediately
const sub = await admin.subscribeWebhooks(id.identityId, "https://gateway.example/hooks/inkbox");
await admin.enableA2A(id.handle);
```

`provisionIdentity` creates a new identity by default. A taken handle gets `-2`, `-3`
suffixes; it does not silently import that existing identity. Import intentionally with
`reuseExisting: true` (CLI: `instinct init --use-existing`). The CLI also resumes an
identity already recorded in its own secrets file. A plan limit (HTTP 402) throws
`InkboxPlanLimitError` with the console billing URL. A phone-inventory 429 retries without a number.

`ensureSigningKey` reuses a supplied `knownSigningKey` when the identity already has one.
If that key is unavailable, initialization stops rather than replacing it. Rotation is
explicit: `{ rotate: true }`, or `instinct init --rotate-signing-key`. Save each one-time
credential before proceeding to later provisioning steps.

### Rate limits

The REST helper retries reads (`GET`/`HEAD`) and requests explicitly marked replay-safe.
A2A `SendMessage` is replay-safe because each attempt keeps the same message ID. For those
requests, a 429, 502, 503 or 504 is retried up to two more times when `Retry-After` is 5 s or
less (or absent for 5xx), waiting `max(Retry-After, 250ms * 2^attempt)`. A 429 without
`Retry-After` is returned immediately. Provisioning mutations and worker-reply POSTs are
not automatically retried by this helper. SDK-backed message sends retain the SDK's own
idempotency/retry handling. `InkboxHttpError.retryAfterSeconds` lets callers report the wait.

## The iMessage router and the connect flow

iMessage does not let an arbitrary server own a phone number. Inkbox runs a shared
**router line**. A human connects to one agent by texting that line once:

1. The gateway calls `admin.routerInfo()` and gets `{ number, connectCommand, smsLink, qrPngDataUrl }`.
2. The signup page shows the QR (or the `sms:` link). The person's phone opens Messages with
   `connect @maria-instinct` prefilled, addressed to the router number.
3. They send it. Inkbox creates an iMessage **conversation** between that phone and the identity.
4. From then on, every message they send arrives as an `imessage.received` webhook with a stable
   `conversation_id`. Replies go back with `sendIMessage({ conversationId })`.

The agent cannot start a conversation with a stranger on the shared line; it can only answer in
conversations people opened. `sendIMessage({ to })` also works for a recipient who already
has an active connection on the shared service. Starting a conversation with an unconnected
recipient requires a suitable dedicated line and remains subject to sending limits.

### The dedicated pool: the agent texts first

Organizations with a dedicated iMessage pool can skip the router: `connectRecipient`
binds a phone number to an identity and sends the opening text from one of the pool
numbers, so the person never has to text `connect @handle`.

```ts
const out = await admin.connectRecipient({
  identityId: id.id,
  recipientNumber: "+14155550100",
  firstMessage: "Hi Ada, I'm your agent. Reply here and we're on.", // under 160 characters
  idempotencyKey: randomUUID(), // made once per connect, reused on a retry
});
// out.assignmentId, out.conversationId, out.messageId, out.alreadyConnected
```

Until the recipient replies, nothing else may be sent on that connection (Inkbox answers
`409 imessage_awaiting_inbound`). A refused connect throws `InkboxConnectError` with the
HTTP status and Inkbox's code (`imessage_pool_unavailable`, `entitlement_exceeded`, ...).
`disconnectRecipient` undoes it; an already-disconnected pair counts as done.

## Webhooks

Subscribe once per identity. The default event list is:

```
imessage.received, imessage.reaction_received, text.received, message.received,
a2a.task.created, a2a.task.message, a2a.task.canceled, a2a.sent_task.updated
```

`parseInkboxEvent` turns each of these into an `InboundMessage`; delivery lifecycle events
(`*.sent`, `*.delivered`, `*.bounced`, `*.failed`) return `undefined`. The two A2A lifecycle
events matter for the caller side of a conversation:

- `a2a.sent_task.updated` is the peer's progress or answer on a task we sent. `from` is the peer
  (`data.sender`, never our own `caller`), the text is the joined text parts or `[<state>]` when
  the update is a bare state change, `data` is the first data part (the OIP reply), and
  `meta.direction` is `"sent"`. The runtime uses the persisted delegation route to resume
  the originating conversation; it does not answer an outbound task as its worker.
- `a2a.task.canceled` identifies the canceled task. The runtime records its terminal state,
  stops active work, and prevents pending approvals from resuming that task.

Every delivery is signed. Verify before parsing:

```ts
import { DurableInbox, InkboxInboundHydrator, parseInkboxEvent, verifyInkboxSignature } from "@open-instinct/inkbox";
import type { InboundMessage } from "@open-instinct/core";

const hydrator = new InkboxInboundHydrator({ channel, mediaDir: state.path("workspace", "inbound") });
const inbox = new DurableInbox<InboundMessage>({
  file: state.path("inkbox-inbox.json"),
  handle: async (inbound) => { await runtime.handleInbound(await hydrator.hydrate(inbound), { waitForCompletion: true }); },
});
inbox.start();

// raw body as Buffer or string; headers as received
if (!verifyInkboxSignature(rawBody, req.headers, signingKey)) return res.status(403).end();
const inbound = parseInkboxEvent(JSON.parse(rawBody.toString()));
if (inbound) inbox.enqueue(inbound.id, inbound); // persisted before returning success
res.status(204).end();
```

The signature is `sha256=<hex>` of HMAC-SHA256 over `"{X-Inkbox-Request-ID}.{X-Inkbox-Timestamp}." + rawBody`,
keyed with the signing key (the `whsec_` prefix is stripped, like the SDK does). The check also rejects
timestamps more than 300 seconds from now; pass `{ toleranceSeconds }` to change that.

`parseInkboxEvent` maps:

| Event | channel | conversationKey | from | text |
|---|---|---|---|---|
| `imessage.received` | `imessage` | `imessage:<conversation_id>` | `remote_number` (`sender_number` in groups) | `content`; media become `attachments` |
| `imessage.reaction_received` | `imessage` | `imessage:<conversation_id>` | `remote_number` | `[reaction love on message <id>]` |
| `text.received` | `sms` | `sms:<conversation_id>` (legacy fallback: phone) | normalized sender number | `text` |
| `message.received` | `email` | `email:<thread_id>` | `from_address` | `Subject: ...\n\n<body>` |
| `a2a.task.created`, `a2a.task.message` | `a2a` | `a2a:<context_id>` | caller handle | joined text parts; first data part in `data` |

`replyRef` carries what a reply needs: iMessage conversation and message ids, the mail
RFC `Message-ID` and subject, or the A2A task and context ids. The webhook `id` becomes
`InboundMessage.id` so the runtime can drop replays.

The parser is synchronous and does not fetch missing data. Run `hydrate()` before
runtime admission; the server wires this automatically. Reaction and SMS events need a
conversation lookup to distinguish groups from private threads. If that lookup is
unavailable, the event remains queued for retry instead of being treated as private.
Group replies keep the group's conversation ID and respect its audience's tier.

Email hydration retrieves a missing/truncated body and attachment download URLs. With
`mediaDir`, inbound email/iMessage/MMS media is downloaded to generated workspace filenames:
at most 10 files per event, 10 MiB each by default. Failed downloads retain the complete
URL and an explicit note; URLs are not shortened. Without `mediaDir`, attachments keep
their complete URLs. Complete, attachment-free email requires no content lookup.

`DurableInbox` records admission before returning success and resumes queued receipts
after restart. Gateway forwarding can be repeated safely with the same event ID because
the receiving agent deduplicates it. On the agent, failures before model admission remain
retryable; an interrupted admitted turn with an uncertain outcome is recorded as
`uncertain`, not blindly replayed. Back up the receipt file with the rest of the agent
state. It is a single-process store, not a shared queue for multiple replicas.
If a handler throws `new RetryAfterError(message, delayMs)`, the inbox persists a next
attempt time at least `delayMs` away while still applying its normal backoff.

## Sending

`InkboxChannel` implements core's `Outbox`. It fetches the `AgentIdentity` once and routes
on the conversation key:

| Key or message | Call |
|---|---|
| `imessage:<id>` | `sendIMessage({ conversationId })`, split over 1500 characters into several bubbles |
| `imessage` with `to` and no key | `sendIMessage({ to })`; existing shared connection or suitable dedicated line |
| `sms:<conversation-id>` | `sendText({ conversationId })`, preserving all participants |
| Legacy `sms:<E.164>` or explicit `to` | `sendText({ to })` |
| `email:<thread>` | `sendEmail` with `Re: <subject>` and `inReplyToMessageId` from `replyRef`; the recipient is `to`, else `replyRef.from` (the inbound sender, which `parseInkboxEvent` records), else what `channel.remember(inbound)` saw |
| `a2a:<ctx>` | `a2aReply(taskId, { intent, parts })`; the task id comes from `msg.a2a`, else `replyRef.taskId`, else `remember()`; the intent defaults to `complete` |

The runtime attaches the inbound message's `replyRef` to the outbound it builds from a reply, so
email and A2A answers need no extra bookkeeping. Messaging tools receive the same `replyRef`
and a separate `deliveryKey`, so group session identifiers never become wire conversation IDs.
`remember()` remains a fallback for other callers that intentionally omit a reply reference.

```ts
const channel = new InkboxChannel({ apiKey: process.env.INKBOX_API_KEY!, handle: "maria-instinct" });
await channel.typing("imessage:conv_1");
await channel.send({ channel: "imessage", conversationKey: "imessage:conv_1", text: "Booked. Thu 7pm at Nopa." }, { principal, conversationKey });
await channel.react("imessage:conv_1", messageId, "love");
```

## A2A: how two Instincts talk

Our agent is a **worker** when another agent calls it, and a **caller** when it reaches out.

- Worker: Inkbox stores the task and posts `a2a.task.created`. The runtime answers through
  `InkboxA2A.reply(taskId, "progress" | "complete" | "ask_caller" | "fail", text, data?)`, which is
  `POST /api/v1/identities/{handle}/a2a/tasks/{id}/reply`.
- Caller: `InkboxA2A.send(peerHandle, text, data?, { contextId?, taskId? })` posts A2A 1.0 JSON-RPC
  `SendMessage` to `https://inkbox.ai/a2a/{peer}` with the identity key and `A2A-Version: 1.0`.
  It returns `{ taskId, contextId, state }`. Reuse `contextId` to keep one topic together;
  include `taskId` to continue the same task after the peer requests more input.
- Both sides must allow each other (gate 1) and the caller must map to a contact with a tier that
  permits the request (gate 2, in core's policy). `admin.addContactRule(handle, peer)` opens gate 1
  for one pair; `admin.createInvitation({ peerHandles })` lets a stranger's agent accept a link that
  opens both directions at once.

The text part is for any A2A agent. The data part carries the typed OIP/1 intent (`docs/PROTOCOL.md`).
The server shares an `A2AStore` between the network tools and runtime. It persists originating
reply routes and task lifecycle state. Worker replies are bound to the admitted task;
separate tasks in one context execute separately.
The network tool does not start nested delegations from an inbound A2A task. Workers
request missing information through `reply_instinct` with `ask_caller` instead.

## Tools

`messagingTools({ channel, contacts, config, dataDir })` returns four tools tagged `converse` in the `messaging` group:

- `send_message { to?, channel?, text, subject? }`. No `to` replies in the current conversation.
  `to` is a contact id or name, a phone, an email, or `"owner"`. A non-owner may only reply in
  their own thread or write to the owner; the tool refuses anything else and the message to the
  owner is prefixed with who sent it.
- `send_typing {}` shows the iMessage typing indicator.
- `react { messageId, reaction }` sends a tapback after checking that the message belongs
  to the current delivery conversation.
- `send_file { path, to?, channel?, caption?, subject? }` sends a file as an attachment. It is also
  tagged `files.read`. Relative paths resolve under `<dataDir>/workspace`; absolute paths must stay
  under `dataDir` after symlinks. iMessage and SMS go through `uploadIMessageMedia` (10 MB limit,
  the error suggests email); email attaches up to 25 MB. With no `to` in a `chat:*` conversation
  (the Maritime dashboard or `instinct chat`) it returns the path plus a fenced `maritime-file`
  block the dashboard renders as an attachment. Without `dataDir` every path is refused.

`sendFileTool({ contacts, config, dataDir, channel? })` is the same tool on its own. The server
registers it without a channel when Inkbox is not configured, so the dashboard chat still gets
files; any send that needs a wire then fails with a plain reason.

## Testing

```
pnpm --filter @open-instinct/inkbox test
```

Tests use a recording fake `fetch`. The provisioner and A2A client take it as `fetchImpl`.
The channel's sends run through the SDK, which reads the global `fetch` at call time, so the
channel tests stub `globalThis.fetch` with the same fake.

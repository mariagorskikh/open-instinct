# Audit webhook

The audit webhook sends a signed copy of each audit entry to one URL the owner chose: a monitoring
service, an insurer, or their own server. It is off until the owner connects one.

## Connect

The owner says it in chat: "Send a copy of my audit log to https://example.com/hook, secret ...".
The agent calls `audit_webhook` with action `connect`. Only the owner, in their own message, can
connect, change or stop it. A web page, an email or another agent cannot point the copies
somewhere else.

A deployer can set it before the agent starts instead:

```bash
export INSTINCT_AUDIT_WEBHOOK_URL=https://example.com/hook
export INSTINCT_AUDIT_WEBHOOK_SECRET=...   # at least 16 characters, from the receiving service
```

These apply only while no webhook is connected. The URL must be https on a public host. The
secret is kept in `secrets/audit-webhook.json` (mode 0600).

"Stop sending my audit log" disconnects it. Action `status` says where copies go.

## What a copy holds

Each POST body is JSON:

```json
{
  "id": "5d1e0c9a7b3f4e2a8c6d1b0f",
  "source": "open-instinct",
  "agent": "sam-instinct",
  "model": "anthropic/claude-sonnet-5-5",
  "entry": {
    "at": "2026-11-15T18:04:11.201Z",
    "kind": "tool_call",
    "principal": "owner",
    "tier": "owner",
    "conversation": "a1b2c3d4e5f6a7b8",
    "detail": { "tool": "web_search", "isError": false, "summary": "search flights to Lisbon" },
    "decision": { "outcome": "allow" }
  }
}
```

A copy carries facts, not content. Result previews, message text, phone numbers, email addresses
and conversation keys stay home. `principal` is a kind (owner, contact, stranger, system), never a
phone number. `conversation` is a hash, so entries can be grouped without revealing who was
talking. `model` comes from the runtime, so the receiver need not take the agent's word for it.

A tool call carries the policy decision that let it run: allowed, allowed through a standing grant
(`viaGrant`), or approved by the owner for this call (`approved: true`). The receiver can tell on
whose authority the agent acted.

## Headers

- `X-Instinct-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`, keyed with the secret.
  The same scheme as GitHub webhooks.
- `X-Instinct-Event`: the entry kind.
- `X-Instinct-Delivery`: the copy id. It stays the same on a retry, so the receiver can drop
  duplicates.

Check the signature before trusting a copy:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody: string, header: string, secret: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
```

## Delivery

Copies go out in order, one at a time, with two retries (after 1 and 5 seconds). A 4xx answer
other than 408 and 429 drops the copy: a bad signature or an unknown agent will not get better by
retrying. If the receiver stays unreachable, copies wait in `audit-webhook-outbox.jsonl` (the
latest 1000) and go out ahead of the next new entry. A slow or failing receiver never blocks the
agent or the audit log.

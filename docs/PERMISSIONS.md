# Trust tiers and permissions

Instinct's trusted network works because each person in your life gets a different amount
of access. Your partner's Instinct can see your calendar; a friend's can only ask when you
are free; a stranger can leave a message. Open Instinct makes that table explicit, editable
in plain English, and enforced in code.

Analogy: tiers are like keys to your house. The owner has every key. A partner has the front
door. Family has the guest room. Friends can ring the bell. Strangers can leave a note.

## Tiers

| Tier | Who | Default access |
|---|---|---|
| `owner` | you | everything, within the spend limits you set |
| `partner` | spouse or partner | read your calendar, propose and hold bookings, book with your approval, see your location, know most of your preferences |
| `family` | close family | see free/busy, coordinate plans, approximate location, some preferences |
| `friend` | friends and their Instincts | see free/busy, propose plans, be told yes or no |
| `contact` | people you know (colleagues, services) | converse, pass a message to you, get public facts about you |
| `stranger` | anyone else | one short introduction, leave a message; rate limited |

A person is placed in a tier by the owner ("Sam is my partner", "put Alex at friend") or by
accepting an invitation that names a tier. Agents inherit the tier of the person they act for.

In shared message threads, every sender is limited to the least-trusted audience member.
Personal grants do not expand what may be shared with that audience. If membership cannot
be resolved, the message is not processed until its conversation scope is available.
Delegated results retain the original audience cap and later reductions observed in the
requester's trust tier or local conversation. Membership is not fetched again solely for
delivery of the remote result.

## Capabilities

Each tool call is tagged with the capabilities it needs. The guard allows a call when the
principal's tier (plus any active grant) includes every capability, and the call is inside any
spend or scope limit.

| Capability | owner | partner | family | friend | contact | stranger |
|---|---|---|---|---|---|---|
| `converse` | yes | yes | yes | yes | yes | intro only |
| `owner.relay` (leave a message for the owner) | n/a | yes | yes | yes | yes | yes, 3/day |
| `owner.profile.public` (name, city, public links) | yes | yes | yes | yes | yes | no |
| `owner.profile.preferences` (food, travel, habits) | yes | most | some | little | no | no |
| `owner.location.exact` | yes | yes | no | no | no | no |
| `owner.location.approx` (city, home/away) | yes | yes | yes | no | no | no |
| `calendar.freebusy` | yes | yes | yes | yes | no | no |
| `calendar.read` (titles, attendees) | yes | yes | no | no | no | no |
| `calendar.write` | yes | ask | ask | no | no | no |
| `email.read` | yes | no | no | no | no | no |
| `email.send` (as the agent) | yes | ask | no | no | no | no |
| `contacts.read` | yes | partial | no | no | no | no |
| `plans.propose` (suggest times, places, hold a table) | yes | yes | yes | yes | no | no |
| `plans.commit` (book, RSVP for the owner) | yes | ask | ask | ask | no | no |
| `purchase` (spend money) | limit | ask | no | no | no | no |
| `travel.book` | limit | ask | no | no | no | no |
| `computer.use` | yes | no | no | no | no | no |
| `files.read`, `files.write` | yes | no | no | no | no | no |
| `memory.write` | yes | no | no | no | no | no |
| `network.ask` (ask another Instinct on the owner's behalf) | yes | yes | yes | yes | no | no |
| `network.invite` | yes | no | no | no | no | no |
| `trust.manage` | yes | no | no | no | no | no |
| `schedule.manage` | yes | no | no | no | no | no |
| `web.read` (web_search, web_fetch; public hosts only) | yes | yes | yes | yes | no | no |
| `apps.use` (call a connected app tool) | yes | yes | yes | yes | no | no |

Legend: `yes` allowed · `ask` allowed after the owner approves by text · `limit` allowed within the owner's
spend policy, otherwise ask · `no` denied.

The table lives in `packages/core/src/policy.ts`. A test checks the rows with special values against
this file, so change both together.

`web.read` and `apps.use` are transport capabilities. The specific capability on the same tool
(`calendar.freebusy`, `email.send`, ...) does the real gating; these two only say who may use the
transport at all. `web_fetch` fetches public hosts only: it resolves every hostname first and refuses
loopback (127/8, ::1), link-local (169.254/16, fe80::/10), private (10/8, 172.16/12, 192.168/16,
fc00::/7), 0.0.0.0, the shared range that hosts cloud metadata (100.64/10), `localhost`, `*.internal`
and `*.local`. Redirects are followed by hand, at most three hops, and every hop is checked the same way.
Bodies are read up to 1 MiB. This keeps a friend's "fetch http://127.0.0.1:5911/fs/read?path=..." from
reading the agent's own files. The check is a filter on the resolved addresses, not a pin; a server that
wants to close the remaining DNS rebinding window passes a pinned `fetchImpl` into the core tools.

`computer.use` covers every desktop tool, including `request_takeover` and `takeover_status`. Only the
owner has it, so no other person's Instinct can drive the desktop or hand it to a human.

Memory is the owner's notebook. Everyone else sees at most the `## Preferences` section of
`MEMORY.md`: partners get the section ("most"), family and friends get a shorter cut with a reminder to
share only general preferences ("some", "little"), contacts and strangers get nothing. An unstructured
`MEMORY.md` with no such heading shares nothing.

### Payments

The `payment_*` tools from `@open-instinct/payments` sit under the same table.

| Tool | Capability | Who, in practice |
|---|---|---|
| `payment_connect` | `purchase` | owner only; the tool refuses everyone else whatever the policy says |
| `payment_request` | `purchase`, with the amount checked by the spend policy | owner within limits; partner after the owner approves each one |
| `payment_status` | `purchase` | same as `payment_request`; returns the one-time card exactly once |
| `payment_list` | `purchase` | owner only |

The Link approval screen is a second check on top of this one. The owner sees the exact amount and
merchant in Link before any card exists. The spend policy matches merchants on arguments named
`merchant`, `merchantName`, `vendor`, `store` and the like, so the allowed and blocked merchant lists
apply to `payment_request`. A purchase counts toward the daily total once, when it is requested, and is given back if Link denies or expires it. See
[packages/payments/README.md](../packages/payments/README.md).

## Who is the owner

The owner is recognised in full only where the sender identity is bound to the carrier or to the
process: iMessage and SMS from a phone in `config.owner.phones`, the local `chat` endpoint, and
`scheduled` and `system` runs.

Email is different. A `From` header can be forged and the mail webhook carries no SPF, DKIM or DMARC
result, so an email from the owner's own address resolves to the `owner:email` principal: a contact at
tier `partner`, wrapped as untrusted like any other contact, with no `bash`, files, computer, `email.read`
or memory, and no power to settle approvals. Anything that needs the owner's say-so is still confirmed by
text. The literal sender `owner` is never a sentinel on a network channel, and `owner` is a reserved agent
handle that no contact may carry; the gateway signup form and `instinct init --handle` refuse it too.

## Group threads

An iMessage group gives every participant the same Inkbox conversation. Inside the agent each
participant gets their own Agent and transcript (`imessage:<conversation_id>:<principal id>`), so a
colleague in the group never has the owner's earlier turns, tool results or calendar details in context.
Replies still land in the group thread. Because every reply is visible to everyone, the owner's own
turns in a group run at the lowest tier present among the participants (unknown numbers count as
strangers; a missing member list counts as stranger), and a bare "yes" in a group never settles an
approval. Approval texts always go to the owner's own thread or phone, never to a group.

## Group plans (fan-out)

A group plan is different from a group thread. "Dinner with Sam and Priya" makes the owner's agent call
`ask_instinct` with `contacts: ["Sam", "Priya"]`. The tool sends the same intent, subject and payload to
each person separately:

- A contact with an Instinct gets an A2A task of their own. Their reply comes back in its own
  `a2a:<context_id>` conversation. The model combines the answers for the owner.
- A contact without an Instinct gets the same request as a text or email, written by `oipToText`.
  This fallback is the owner's alone.
- The tool returns one line per person and `details.results` with each person's `ok`, `via`,
  `taskId` and `contextId`. `contextId` continues one peer's topic, so it is refused with several
  contacts.

The tier rules apply per recipient on the receiving side: each Instinct answers with what the owner's
tier on *their* side allows. On the sending side, a partner, family member or friend may use
`ask_instinct` only to reach their own Instinct through this one. Any other name, known or not, gets
the same generic refusal; the contact list is never enumerated. Their request goes out prefixed with
who asked ("From Jo, relayed by Maria's Instinct (not Maria's request): ...") and `on_behalf_of.display`
names them, never the owner.

## Grants

A grant is a scoped, time-boxed exception the owner creates in chat. The model turns the owner's
words into a `trust_grant` call:

```json
{
  "to": "contact:sam",
  "capabilities": ["calendar.write", "plans.commit"],
  "scope": { "purpose": "dinner", "window": { "from": "2026-10-06", "to": "2026-10-12" }, "maxUsd": 150 },
  "expiresAt": "2026-10-13T00:00:00-04:00",
  "note": "Sam can book us dinner this week"
}
```

Grants are additive and never widen past `owner`. They are listed with `trust_list`, revoked with
`trust_revoke`, and expire on their own. The CLI can do the same from a terminal:
`instinct trust grant sam-lee calendar.write,plans.commit --until 2026-10-12 --max-usd 150 --note "dinner this week"`.

A grant that covers `purchase` or `travel.book` is still spending. The spend policy below runs with the
grant's `maxUsd` as the ask threshold: blocked merchants are denied, flights and hotels (anything in
`neverWithoutAsk`) still ask, an unknown amount asks, the per-action limit and the daily total still hold.
Only an amount within every limit is allowed, and the audit entry names the grant. Blocked merchants are
blocked for every tier, grant or not.

## Spend policy (owner)

```json
{
  "perActionUsd": 100,
  "perDayUsd": 300,
  "askAbove": 50,
  "neverWithoutAsk": ["flights", "hotels"],
  "allowedMerchants": [],
  "blockedMerchants": []
}
```

Anything above `askAbove` sends the owner an approval text:

> Book Nopa, Thu 7:00 pm, 2 people, $0 deposit? Reply YES or NO. Token K7P2. (expires in 2 h)

The approval token is stored in `approvals.json`. The owner's reply resolves it; the waiting
conversation continues with `followUp`.

### How a reply settles an approval

- A reply that names the token always counts: "yes K7P2", "no, K7P2", "ok k7p2". Any text after the
  verdict and the token ("yes K7P2 and remind me to call mom") still runs in the owner's own thread.
- A bare "yes" or "no" counts only when all of these hold: exactly one approval is pending; the text
  is a short plain verdict ("yes", "yes please", "no thanks", "approve", "go ahead"; never "ok", "sure",
  "yeah", "go", "cancel my 3pm" or a sentence); and the approval is either the owner's own request with
  no money involved, or the owner used an explicit verb ("approve", "deny"), or the approval text is the
  last thing the agent said to the owner. The last rule is what keeps "sure" to a weather question from
  approving a partner's hotel.
- Replies count only from carrier-bound or local channels: iMessage, SMS and `chat`. Never from email,
  A2A or a group thread.
- An approval is for one exact call: same conversation, same requester, same tool, same arguments
  (hashed), same amount within 5%. The model's retry of that call passes once, within 15 minutes.
  A different merchant, amount or title needs a new approval. An `ask_owner` question ("Did you get
  Sam's message?") never pre-authorises anything; it only informs the model through the
  "Owner approved" follow-up.

## How the guard works

1. The server resolves the principal and its tier.
2. The prompt builder shows the model only the tools whose capabilities the tier can ever have.
3. Every call goes through `beforeToolCall`:
   - look up the tool's capability tags;
   - check tier defaults, then active grants;
   - for `ask` outcomes, create an approval and return a blocked result telling the model to
     wait for the owner;
   - for spend, check the limits and today's total from the audit log;
   - log the decision to `audit.jsonl`.
4. A blocked call returns a tool error the model can explain to the requester politely.
5. The guard is enforced twice (next section).

## Enforced twice: decline, and tell the owner

A refusal is never silent. When the policy denies a request from anyone but the owner, two things
happen:

1. The requester hears a polite no. The tool result tells the model "Blocked by policy ... Do not
   retry. Explain politely that you cannot do this for them."
2. The owner hears that it was asked. The agent texts the owner's phone:

   > Sam's agent (@sam-instinct) asked to read your calendar; I declined.

   For an `ask` outcome the approval text itself is the notice ("... ; I am asking you first").

One notice per conversation per hour, so a chatty peer cannot flood the owner's phone. The last
notice time per conversation is in `owner-notices.json`. Every notice is also an audit entry
(`kind: "policy"`, `ownerNotified: true`), so "who asked for what today" can be answered from
`audit_read`.

The prompt backs the code. The network guidance tells the model that an out-of-scope request from
another agent is declined with `fail` and reported to the owner rather than carried out. The smoke
test (`pnpm smoke`) exercises the whole path: a stranger's agent asks for the calendar over A2A, the
only tool the policy allows is `notify_owner`, the owner gets exactly one text, the task is completed
with a refusal, and nothing from `MEMORY.md` leaves the process.

## Owner commands (natural language, mapped to tools)

- "Sam is my partner" → `trust_set_tier`
- "Let Alex see my calendar this week" → `trust_grant`
- "Stop sharing my location with family" → `trust_revoke`
- "Who can do what?" → `trust_list`
- "Invite Priya's Instinct" → `invite_to_network`
- "Connect my wallet" → `payment_connect`
- "What did you do today?" → `audit_read`

The same from a terminal: `instinct trust list | set <contact> <tier> | grant ... | revoke <grantId>`
and `instinct invite "Sam Lee" --tier partner --handle sam-instinct`.

## Defaults for a new agent

- Owner identified by the phone number and email given at signup.
- Everyone else is `stranger` until placed.
- Stranger rate limit: 3 conversations per day, 10 messages each.
- Spend policy: ask above $50, never book flights or hotels without asking.

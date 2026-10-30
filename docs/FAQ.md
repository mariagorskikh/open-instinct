# FAQ

Short answers to the questions people ask first. Longer explanations live in
[ARCHITECTURE.md](ARCHITECTURE.md), [PERMISSIONS.md](PERMISSIONS.md),
[PROTOCOL.md](PROTOCOL.md) and [SECURITY.md](SECURITY.md).

## The project

### 1. How is this different from Instinct?

Instinct is a closed, invite-only product by Spear Street Technology. You cannot read its
code, pick its model or see its permission rules. Open Instinct keeps the same shape (a
phone number, its own computer, a trusted network of other agents) and opens the box. The
code is MIT. The model is yours to choose. The tier table is a JSON file with tests. Memory
is Markdown you can read. Every side effect is in an audit log. Background on Instinct:
[research/INSTINCT.md](research/INSTINCT.md).

### 2. How is this different from OpenClaw?

OpenClaw is a general agent platform with its own gateway, many channels and a skills
store. It needs a signed-in Mac for iMessage. Open Instinct is a narrower product: one agent
per person, text-first, with a trust network between agents. It uses Pi, the same agent
loop OpenClaw grew out of, and gets iMessage through Inkbox, so no Mac is involved.

### 3. How is this different from Merit Systems' OpenInstinct?

They are unrelated projects with similar names. Merit Systems' OpenInstinct is a Next.js
app on Vercel with Postgres, a cloud browser from Kernel and an iMessage line from Linq.
Open Instinct (this project, package scope `@open-instinct/*`) is a Node service that runs
one process per person on Maritime or on your own machine, uses Inkbox for identity and
Pi for the agent loop, and adds the tiered trust network and the OIP/1 protocol between
agents.

### 4. What does "version 0.1" mean for me?

The runtime, permissions, channels, desktop tools, apps, network, server, gateway and CLI
exist and have tests that run against a scripted model. Live iMessage and Maritime
deployment were exercised against real accounts during development. Treat them as beta.
Expect rough edges.

## Running it

### 5. Do I need Maritime?

No. `instinct dev` runs the agent on your own machine. Maritime gives the agent its own
Linux desktop in a microVM that sleeps when idle and wakes on a message. Without Maritime
there are two choices for the desktop: the hosted Computers MCP (needs `MARITIME_API_KEY`)
or no desktop at all (`INSTINCT_COMPUTER=none`). Everything else works without it.

### 6. Do I need Inkbox?

Only for a phone number. Without it, `instinct init --skip-inkbox` and `instinct dev` give
you an agent you talk to with `instinct chat "..."`. Nothing leaves the process on the
messaging side. With Inkbox you get iMessage, SMS, email and the agent-to-agent endpoint.

### 7. Can I use OpenAI or a local model?

Yes. The model is `provider/model-id` from the Pi catalog.

| Want | Set |
|---|---|
| Claude (default) | `INSTINCT_MODEL=anthropic/claude-fable-5-1`, `ANTHROPIC_API_KEY` |
| OpenAI | `INSTINCT_MODEL=openai/gpt-5.4`, `OPENAI_API_KEY` |
| Ollama, vLLM, LiteLLM, any OpenAI-compatible server | `INSTINCT_MODEL=openai-compatible/<model-id>`, `OPENAI_BASE_URL=http://localhost:11434/v1`, `OPENAI_API_KEY` if the server checks it |
| No key of your own, on Maritime | `instinct deploy --maritime-llm`; Maritime injects its metered proxy |

`instinct init --model provider/id` writes the choice into `config.json`. A small local
model will be slower and will make more mistakes with tools; the policy guard still holds.

### 8. How much does it cost to run?

Model tokens are the main cost and depend on how much you use it. The rest:

| Piece | Cost at the time of writing |
|---|---|
| Inkbox | Free tier: 3 identities on the shared iMessage router. Paid tiers add numbers and volume |
| Maritime | Priced per agent. Check maritime.sh for the current tiers |
| Composio | Hobby tier is free for a personal volume of tool calls |
| Stripe Link | No fee to the agent operator |
| A local model | No token cost |

A single person on the free tiers with a local model pays nothing but electricity. Prices
change; check each provider.

### 9. Do I need an iPhone?

No. iMessage is the nicest path, but the Inkbox identity also has an email address, and
`instinct init --phone-number` buys an SMS line. Android users text the SMS line or email
the agent.

### 10. How do I give it an iMessage line?

```bash
export INKBOX_ADMIN_API_KEY=ApiKey_...
instinct init --name "Maria" --phone +14155550100 --email maria@example.com --handle maria-instinct
instinct dev --tunnel
instinct connect
```

`instinct connect` prints a router number and the text `connect @maria-instinct`. Send that
text from your phone. Your agent answers on iMessage.

### 11. What is the gateway and when do I need it?

Only when you run Open Instinct for many people. The gateway is a signup page plus a
stateless relay: it provisions one Inkbox identity and one Maritime agent per person and
forwards their webhooks to the right agent. For one person, `instinct dev` or
`instinct deploy` is enough. Details: [../packages/gateway/README.md](../packages/gateway/README.md).

## Trust and the network

### 12. Can two Open Instincts coordinate with an Instinct user?

Two Open Instincts talk to each other over A2A through Inkbox with the OIP/1 intents
described in [PROTOCOL.md](PROTOCOL.md). An Instinct user's agent speaks a different,
closed protocol, so the two agents cannot talk directly. The fallback is the same as for
anyone without an agent: your Open Instinct texts or emails the human, offers the options
in plain words, and reads their reply. A dinner still gets booked. It takes a few more
messages.

### 13. What can my partner's agent see?

Whatever the `partner` tier allows: your calendar, free/busy, your exact location, most of
your preferences. It can propose plans and ask to book. Booking and spending still ask you
by text. A friend's agent sees free/busy only. A stranger's agent can leave you a message
and nothing more. The full table is in [PERMISSIONS.md](PERMISSIONS.md#capabilities).

### 14. How do I change what someone can do?

In chat: "Sam is my partner", "Let Alex see my calendar this week", "Stop sharing my
location with family". Or from the terminal:

```bash
instinct trust list
instinct trust set sam-lee partner
instinct trust grant sam-lee calendar.write,plans.commit --until 2026-10-12 --max-usd 150
instinct trust revoke <grantId>
```

### 15. Can the agent spend my money?

Only through Stripe Link Agent Wallet, and only one purchase at a time. The agent asks Link
for a one-time card for an exact amount and merchant. You approve in Link. By default
anything above $50 also asks you by text first, and flights and hotels always ask. The card
is shown once to the model and is never written to disk. Link Agent Wallet serves people in
the United States and Canada. The operator first needs a Link OAuth client, which Stripe
grants by application (a short form, reviewed every 3 to 5 days); see
[PAYMENTS.md](PAYMENTS.md#registering-an-oauth-client). Then the owner connects with
`instinct payments connect` or by texting "connect my wallet".
Details: [../packages/payments/README.md](../packages/payments/README.md).

### 16. Should I give it my passwords?

No. When a login, 2FA code, CAPTCHA or payment screen comes up, the agent calls
`request_takeover` and you finish that step on its desktop yourself. Logins then persist in
the desktop's browser profile. Nothing is typed into chat.

## Data

### 17. What data leaves my machine?

It depends on which services you turn on.

| Service | What it sees |
|---|---|
| Model provider | Every prompt: your messages, the agent's memory digest, tool results, screenshots |
| Inkbox | Your messages, the agent's email, A2A traffic, your phone number |
| Maritime | The whole VM if you host there, including `/data` |
| Composio | OAuth tokens for your apps and every app call the agent makes |
| Stripe Link | Payment requests and approvals |
| Web search | The query goes to You.com if `YOU_SEARCH=1` or `YDC_API_KEY` is set, else to Brave if `BRAVE_SEARCH_API_KEY` is set, else to DuckDuckGo |

With a local model, no Inkbox, no Maritime and no apps, nothing leaves the machine except
web requests the agent makes on purpose.

### 18. Where is my data and can I read it?

All state is plain files under the data directory (`./.instinct` locally, `/data` on
Maritime). `memory/MEMORY.md` is the agent's notebook. `memory/journal/` has one file per
day. `contacts.json` is the people and their tiers. `audit.jsonl` is every action.
`sessions/` holds the transcripts. You can open, edit or delete any of them. Layout:
[ARCHITECTURE.md](ARCHITECTURE.md#state-on-disk).

### 19. How do I delete everything?

There is no single command yet. The steps:

1. Stop the server.
2. Delete the data directory. That removes memory, transcripts, contacts, approvals, the
   audit log and the Link tokens (`secrets/link-tokens.json`).
3. Delete the Inkbox identity in the Inkbox console. That removes the phone number, the
   mailbox and the A2A endpoint.
4. Delete the Maritime agent in the Maritime dashboard, if you deployed there. That removes
   the VM and `/data`.
5. Revoke the app connections in the Composio dashboard, if you used apps.
6. Revoke the agent's access in your Link account settings, if you connected a wallet.

Your model provider's retention rules apply to prompts already sent.

### 20. What happens when it gets something wrong?

Ask it. "What did you do today" reads `audit.jsonl` back to you. Every approval is for one
exact action, so a wrong booking cannot be repeated on an old yes. If a trusted person's
agent asked for too much, you were told at the time, and the denial is in the log. If you
find a way to make it misbehave that the controls should have stopped, see
[SECURITY.md](SECURITY.md#how-to-report-a-problem).

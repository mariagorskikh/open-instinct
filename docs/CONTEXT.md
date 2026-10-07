# Context.dev

Context.dev gives the agent one optional `context_answers` tool for questions
that need current public web or webpage context. It researches the task, returns
structured JSON and includes the source URLs it used.

## Setup

Create an API key at [context.dev](https://context.dev), then export it before
starting or deploying the agent:

```bash
export CONTEXT_DEV_API_KEY=ctxt_secret_...
pnpm instinct dev
```

`instinct deploy` forwards the key to Maritime as an encrypted secret. The
gateway also forwards its `CONTEXT_DEV_API_KEY` to each agent it provisions.

## How the agent uses it

The research skill prefers `context_answers` for current questions,
comparisons and tasks that name public URLs. It uses `fast` mode by default and
`ultra` only for deeper research. Without the key, the tool is absent and the
existing `web_search` and `web_fetch` flow is unchanged.

The tool carries the existing `web.read` capability. Responses are wrapped as
untrusted web data before the model sees them. Private messages, mail, calendar
data, memory and secrets must not be included in research tasks.

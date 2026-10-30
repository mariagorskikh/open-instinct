# Keenable

Keenable gives the agent two optional tools: `keenable_search` for web results
with page text, and `keenable_fetch` for a public page as markdown. They sit next
to `web_search` and `web_fetch`, which stay as they are.

## Setup

No account is needed. Turn it on before starting or deploying the agent:

```bash
export KEENABLE_SEARCH=1
pnpm instinct dev
```

Keyless use is limited per IP address. For higher limits, create a key in the
[Keenable console](https://app.keenable.ai/console) and export it instead; the
key alone also turns the tools on:

```bash
export KEENABLE_API_KEY=keen_...
```

`instinct deploy` forwards both variables to Maritime, the key as an encrypted
secret. The gateway also forwards its `KEENABLE_SEARCH` and `KEENABLE_API_KEY`
to each agent it provisions.

## How the agent uses it

When the tools are present, the research skill says `keenable_search` and
`keenable_fetch` are also available, next to `web_search` and `web_fetch`. Without
`KEENABLE_SEARCH=1` or a key, the tools are absent and the existing
`web_search` and `web_fetch` flow is unchanged.

Keenable receives the search query or the page URL, and the header
`X-Keenable-Title: Open Instinct`. The key is sent only when it is set.

Both tools carry the existing `web.read` capability. `keenable_fetch` refuses
private, loopback and metadata targets, like `web_fetch`. Results are wrapped as
untrusted web data before the model sees them.

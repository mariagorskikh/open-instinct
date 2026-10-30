# Keenable

`@open-instinct/keenable` adds two optional tools that use the Keenable search
API: `keenable_search` returns the top web results with page text, and
`keenable_fetch` returns a public page as markdown.

It works without an account. Turn it on before starting the agent:

```bash
export KEENABLE_SEARCH=1
pnpm instinct dev
```

Setting `KEENABLE_API_KEY` also turns it on and lifts the keyless rate limits.

Both tools are tagged `web.read`, so the existing web permission row controls
access. `keenable_fetch` refuses the same private, loopback and metadata targets
as `web_fetch`. Responses are marked as untrusted web data before the model sees
them.

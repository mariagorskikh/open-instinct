# Context.dev

`@open-instinct/context` adds one optional `context_answers` tool. It uses the
Context.dev Answers API to research current questions, read public URLs and return
a structured answer with the source pages it used.

Set `CONTEXT_DEV_API_KEY` before starting the agent:

```bash
export CONTEXT_DEV_API_KEY=ctxt_secret_...
pnpm instinct dev
```

The tool uses `fast` mode unless the agent requests `ultra` for deeper research.
It is tagged `web.read`, so the existing web permission row controls access. API
responses are marked as untrusted web data before the model sees them.

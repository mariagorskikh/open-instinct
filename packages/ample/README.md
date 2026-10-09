# @open-instinct/ample

Web app deploys for Open Instinct through [Ample](https://ample.computer):
`ample_deploy`, `ample_logs`, `ample_apps` and `ample_app_delete`. See
[docs/AMPLE.md](../../docs/AMPLE.md).

```ts
import { ampleTools } from "@open-instinct/ample";

registry.registerMany(
  ampleTools({
    credentials: { clientId, clientSecret }, // or { token }
    workspaceDir,
    resolvePath: (p) => resolveInsideWorkspace(workspaceDir, p),
  }),
);
```

The tools run the `ample` CLI (`bin`, default `ample` on `PATH`) with a
short-lived access token in its environment and nothing else from the agent's
process. Pass `run` to replace the process runner in tests.

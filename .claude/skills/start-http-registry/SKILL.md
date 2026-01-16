---
name: start-http-registry
description: Start the local HTTP registry server for development. Use when testing infra scripts or commands that need a Abacus work private overrides such as RPC URLS.
---

# Start HTTP Registry Server

Start the http-registry server in the background:

```bash
pnpm -C typescript/infra start:http-registry
```

**Instructions:**

1. Run the command with `run_in_background: true` so it doesn't block the conversation
2. After starting, report the task/shell ID to the user
3. Remind the user they can stop it later with `KillShell` using that ID

**Example output:**

> Started http-registry server in background (shell ID: `shell_abc123`).
> To stop it later, I can use KillShell or you can run `/stop-http-registry`.

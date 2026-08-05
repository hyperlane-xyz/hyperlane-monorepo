---
name: start-http-registry
description: Start the local HTTP registry server for development. Use when testing infra scripts or commands that need a Abacus work private overrides such as RPC URLS.
---

# Start HTTP Registry Server

Start the http-registry server in the background.

**Instructions:**

1. First, find the monorepo root (working directory may have drifted):
   ```bash
   git rev-parse --show-toplevel
   ```
2. Run the command with `run_in_background: true`, prefixing with `cd` to the monorepo root AND `CI=false` inline (see next paragraph for why):

   ```bash
   cd <MONOREPO_ROOT> && CI=false pnpm -C typescript/infra start:http-registry
   ```

   **`--writeMode` (optional):** append `--writeMode` when the calling skill will write artifacts back through the server — `warp deploy`, `warp apply`, and `warp alt create` persist the resulting config/addresses via the write routes. Omit it for read-only flows (`warp read`, `warp check`). Serving private/pinned RPCs (the reason to use the HTTP registry at all) is independent of `--writeMode`; the flag only enables the write routes.

   **Why `CI=false`**: the infra HTTP registry wraps `getRegistryForEnvironment` (`typescript/infra/config/registry.ts:192`), which merges filesystem chain metadata with per-chain RPC overrides. The override source is CI-gated: `CI !== 'true'` → **GCP Secret Manager** (private / keyed URLs like Alchemy, Dwellir, Ankr, TronGrid); `CI === 'true'` → `MAINNET3_<CHAIN>_RPC_URLS` env vars (the GitHub-Actions injection path). On Haggis workers and any environment where those env vars aren't set, `CI=true` silently falls back to the public on-disk registry URLs — which are rate-limited (e.g. Tron's public trongrid.io = 3 rps unauthenticated → 429 during broadcasts). Prefix inline so the setting is scoped to this single invocation; do NOT `export CI=false` globally — other flows in the same session may legitimately need `CI=true`.

3. Wait for the log line `Server running` in the background task's output before any downstream consumer hits the server. This is the canonical readiness signal.
4. **Verify the server is reachable using the `/readiness` endpoint, NOT the root path** — the root returns `404` by design and is not a liveness signal:

   ```bash
   curl -sf http://localhost:<port>/readiness && echo "ok"
   ```

   The server only routes specific paths: `/readiness`, `/metadata`, `/addresses`, `/chains`, `/chain/<name>`, `/warp-route/deploy/<id>`, `/warp-route/deploy?<filter>`, etc. Hitting `http://localhost:<port>/` returns `404` even when the server is healthy. **Do NOT** interpret a root-404 as "server is dead" and fall back to passing the local FS registry path to downstream `--registry` flags — falling back bypasses the centralized RPC config the HTTP registry provides and can cost real mainnet gas on retries against flaky public RPCs.

5. Report the task/shell ID + the port (typically `3333`, read from the logs) to the user.
6. Remind the user they can stop it later with `KillShell` using that ID, or via `/stop-http-registry`.

**Example output:**

> Started http-registry server in background (shell ID: `shell_abc123`) on `http://localhost:3333`. Readiness verified.
> To stop it later, I can use KillShell or you can run `/stop-http-registry`.

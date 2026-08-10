---
name: stop-http-registry
description: Stop the background HTTP registry server started by /start-http-registry — TaskStop / KillShell by the recorded task ID, plus a /proc cmdline-scan fallback for minimal-tool sandboxes with no ps/lsof/pkill/fuser. Referenced by every warp deploy/update skill that starts the registry.
---

# Stop HTTP Registry Server

Stop the background HTTP registry started via `/start-http-registry`. Always stop it at the end of the skill — even on failure paths — so no background process is left running.

1. **Primary:** `TaskStop` (or `KillShell`) with the task/shell ID recorded when the registry was started.
2. **Fallback (minimal-tool sandboxes):** if `TaskStop` doesn't clean up the underlying process and `ps` / `lsof` / `pkill` / `fuser` aren't available, scan `/proc` for the registry's cmdline and kill it:

   ```bash
   # Find PIDs matching the registry process — exclude the scanning shell itself
   SELF_PID=$$
   for pid in $(ls /proc | grep -E '^[0-9]+$'); do
     [ "$pid" = "$SELF_PID" ] && continue
     if grep -aql 'http-registry-server\|start:http-registry' /proc/$pid/cmdline 2>/dev/null; then
       echo "killing http-registry pid=$pid"
       kill "$pid" 2>/dev/null || true
     fi
   done
   ```

   Always run the fallback after `TaskStop` regardless — it is idempotent if the process is already gone.

## Consumers

`/warp-deploy-init-route`, `/warp-deploy-update-owners`, `/warp-update`, `/warp-update-extend`, `/warp-update-resolve-artifacts` — every skill that starts the HTTP registry.

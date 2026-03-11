---
name: fix-rpc-urls
description: Apply RPC URL changes for a chain. Use after /debug-rpc-provider has diagnosed the issue and recommended new URLs. The user invoking this skill is the confirmation gate.
---

# Fix RPC URLs

Apply RPC URL changes to a chain's GCP secret and optionally refresh K8s resources.

## When to Use

1. **After diagnosis:** User ran `/debug-rpc-provider`, saw the recommendation, and says "fix it" or "apply the fix"
2. **Direct request:** User provides a chain and explicit list of new RPC URLs to set

## Input Parameters

The skill parses parameters from conversation context (typically from `/debug-rpc-provider` output):

| Parameter     | Required | Source                             | Description                      |
| ------------- | -------- | ---------------------------------- | -------------------------------- |
| `chain`       | Yes      | Conversation context               | Chain name (e.g., `ethereum`)    |
| `environment` | Yes      | Conversation context or `mainnet3` | `mainnet3` or `testnet4`         |
| `rpcUrls`     | Yes      | Debug skill's proposed URL list    | JSON array of full RPC URLs      |
| `refreshK8s`  | No       | User request, default true         | Whether to refresh K8s resources |

## Workflow

### Step 1: Find Monorepo Root

```bash
MONOREPO_ROOT=$(git rev-parse --show-toplevel)
```

### Step 2: Parse Parameters from Context

Extract from the conversation:

- **chain** and **environment** from the debug skill invocation or user message
- **rpcUrls** from the "Proposed new RPC URLs" JSON array in the debug skill output

If any required parameter cannot be found, output what's missing and stop.

### Step 3: Log the Change

Before making changes, output what will happen:

```
Applying RPC URL changes for <chain> (<environment>):
New URLs: ["https://url1", "https://url2"]
Refresh K8s: yes/no
```

### Step 4: Apply the Change

Run the set-rpc-urls script in non-interactive mode:

```bash
pnpm --dir "$MONOREPO_ROOT/typescript/infra" exec tsx scripts/secret-rpc-urls/set-rpc-urls.ts \
  -e <environment> -c <chain> \
  --rpc-urls '<JSON array of URLs>' \
  --refresh-k8s --yes
```

Omit `--refresh-k8s` if the user explicitly said not to refresh, or if kubectl access is unavailable.

The script validates each URL before applying. If validation fails, it will error out and no changes are made.

### Step 5: Verify the Fix

Run the debug script again to confirm the new URLs are healthy:

```bash
pnpm --dir "$MONOREPO_ROOT/typescript/infra" exec tsx scripts/secret-rpc-urls/debug-rpc-url-health.ts \
  -e <environment> -c <chain>
```

### Step 6: Report Results

Output a summary:

```
RPC URL update for <chain> (<environment>): SUCCESS/FAILED

- Secret updated: yes/no
- K8s resources refreshed: yes/no/skipped
- Verification: all healthy / X of Y healthy
```

## Error Handling

| Error                        | Action                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| Provider validation fails    | Report which URL failed. No changes made. Suggest user provide different URLs.        |
| Secret update fails          | Report error. Check GCP permissions.                                                  |
| K8s refresh fails            | Report error. Secret was already updated. Suggest manual `kubectl` refresh.           |
| Verification shows unhealthy | Report the verification output. The URLs were set but may need further investigation. |

## Important Notes

- **No interactive prompts.** This skill does not use `AskUserQuestion`. The human-in-the-loop gate is the act of invoking `/fix-rpc-urls` itself.
- The URLs from `/debug-rpc-provider` output can be passed directly.
- The `set-rpc-urls.ts` script always validates URLs before applying — there is no way to skip validation.
- If `--refresh-k8s` is used, the script refreshes all dependent K8s resources (relayers, validators, scrapers, warp monitors, rebalancers, cronjobs) without prompting.

---
name: debug-rpc-provider
description: Debug RPC provider health issues for a chain. Use when alerts mention RPC failures, high latency, stale blocks, or provider errors. Diagnoses the issue and recommends fixes.
---

# Debug RPC Provider

Diagnose RPC provider health issues for a Hyperlane chain and recommend fixes.

## When to Use

1. **Alert-triggered:** RPC error rate alerts, provider timeout alerts, stale block alerts
2. **User request:** "debug RPC for [chain]", "why are RPCs unhealthy on [chain]"

## Input Parameters

```
/debug-rpc-provider <chain> [environment=mainnet3]
```

| Parameter     | Required | Default    | Description                   |
| ------------- | -------- | ---------- | ----------------------------- |
| `chain`       | Yes      | -          | Chain name (e.g., `ethereum`) |
| `environment` | No       | `mainnet3` | `mainnet3` or `testnet4`      |

## Workflow

### Step 1: Find Monorepo Root

```bash
MONOREPO_ROOT=$(git rev-parse --show-toplevel)
```

### Step 2: Run Debug Script

```bash
pnpm --dir "$MONOREPO_ROOT/typescript/infra" exec tsx scripts/secret-rpc-urls/debug-rpc-url-health.ts \
  -e <environment> -c <chain>
```

### Step 3: Analyze Results

Examine the output table and classify each RPC URL:

| Condition                     | Classification            |
| ----------------------------- | ------------------------- |
| Health = ✅, Latency < 500ms  | Healthy                   |
| Health = ✅, Latency >= 500ms | Slow                      |
| Health = ⚠️                   | Stale (block age 30-120s) |
| Health = ❌, has error        | Dead                      |
| Health = ❌, chainId mismatch | Misconfigured             |

### Step 4: Output Diagnosis and Recommendation

Output the following structured information:

1. **Summary:** One-line description of the issue (e.g., "2 of 3 private RPCs are dead on ethereum")

2. **Current URL status table:** For each private RPC URL, show status (healthy/slow/stale/dead) and key metrics

3. **Proposed new URL list:** A concrete JSON array of the recommended new private RPC URLs. This should:
   - Remove dead/misconfigured URLs
   - Keep healthy URLs (reorder so healthiest are first)
   - **Always backfill with healthy registry URLs** to replace removed URLs and maintain at least the original URL count. Registry URLs are free and add redundancy.
   - Never leave the list empty

   Format:

   ```
   Proposed new RPC URLs for <chain> (<environment>):
   ["https://full-url-1", "https://full-url-2"]
   ```

4. **Suggested action:** Either:
   - "No action needed" if all private RPCs are healthy
   - "Run `/fix-rpc-urls` to apply the proposed URL changes" if URLs need updating
   - "Investigate further" if the issue is unclear (e.g., all RPCs stale may indicate chain halt)

### Step 5: Offer to Fix (Confirmation Gate)

If you recommended URL changes in Step 4, end your response with the confirmation convention so the user gets an approve/reject button:

```
[CONFIRM: Fix RPC URLs for <chain>]
```

This MUST be the very last thing in your message. Do NOT run `/fix-rpc-urls` yourself — wait for user approval.

If all URLs are healthy and no changes are needed, skip this step.

## Important Notes

- Registry URLs are public and don't contain secrets.
- If ALL RPCs (private + registry) are stale/dead, the chain itself may be halted — check block explorers before recommending URL changes.

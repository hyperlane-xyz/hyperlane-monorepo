---
name: debug-rpc-provider
description: Debug RPC provider health issues. Use when alerts mention "RPC Provider error rate", "RPC errors", or when asked to check RPC health for a chain. Runs the debug-rpc-url-health script and presents actionable results.
---

# Debug RPC Provider Health

## When to Use

1. **Alert-based triggers:**
   - Alert mentions "RPC Provider error rate > 60%" or similar RPC error thresholds
   - Alert names containing "RPC error", "RPC provider", or "RPC health"
   - Any alert referencing high RPC failure rates for a chain

2. **User request triggers:**
   - "Why is RPC failing on [chain]?"
   - "Check RPC health for [chain]"
   - "Debug RPC provider issues on [chain]"
   - "Is [provider] healthy for [chain]?"

## Input Parameters

| Parameter      | Required | Default    | Description                                                                                                                                                                                                                                                               |
| -------------- | -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain`        | Yes      | —          | Chain name from alert or user request (e.g., `ethereum`, `stable`, `arbitrum`)                                                                                                                                                                                            |
| `environment`  | Inferred | `mainnet3` | `mainnet3` or `testnet4`. Infer from chain name: well-known testnets (sepolia, holesky, fuji, alfajores, bsctestnet, plumetestnet, etc.) → `testnet4`, otherwise `mainnet3`. If unsure, check `../hyperlane-registry/chains/<chain>/metadata.yaml` for `isTestnet: true`. |
| `rpc_provider` | No       | —          | Specific provider domain from alert (e.g., `api-stable-mainnet.n.dwellir.com`). Used to highlight that provider in results.                                                                                                                                               |

## Debugging Workflow

### Step 1: Parse Alert / Request

Extract from the alert or user message:

- **chain** — the chain name
- **environment** — infer `mainnet3` or `testnet4` per rules above
- **rpc_provider** — optional provider domain if mentioned in alert

### Step 2: Run the Debug Script

```bash
cd typescript/infra && pnpm tsx scripts/secret-rpc-urls/debug-rpc-url-health.ts -e <environment> -c <chain>
```

This script probes all private (secret) and registry RPCs for the chain and outputs:

- Per-URL health status (✅ healthy, ⚠️ stale, ❌ error)
- Block number, block diff, staleness, latency
- Error messages for failing URLs (with secrets redacted)

### Step 3: Parse and Present Results

From the script output, present a summary:

1. **Overall health status:**
   - **All healthy** — all RPCs returned ✅
   - **Partial failure** — some RPCs are ❌ or ⚠️
   - **Total failure** — all RPCs are ❌

2. **Per-RPC status table** — reproduce the script's table output, simplified:
   - URL (redacted), Block #, Staleness, Health emoji, Latency, Notes

3. **Provider highlight** — if `rpc_provider` was specified, call out that provider's specific status prominently before the full table.

### Step 4: Actionable Summary and Next Steps

Apply these rules to generate recommendations:

**Counting healthy URLs:**

- Only count private RPCs with ✅ status as "healthy URLs"
- ⚠️ (stale) and ❌ (error/timeout) are both "unhealthy"

**Recommendations based on health:**

1. **Unhealthy URLs exist** — suggest removing them from the private RPC secret. Show the proposed new URL list (healthy URLs only, preserving original order).

2. **After removing unhealthy URLs, if < 3 healthy private URLs remain** — suggest adding the healthiest registry URL not already in the private set to the _end_ of the new RPC list. "Healthiest" = same block number as max block, then lowest latency. Only suggest registry URLs with ✅ status.

3. **Only 1 healthy private URL remains** — warn that there is no redundancy. Suggest user find another RPC provider to add.

4. **0 healthy URLs (total failure)** — this is critical. User must find at least one healthy RPC provider before the chain can function. Check if any registry RPCs are healthy as temporary alternatives.

**Format the recommendation as a concrete action**, e.g.:

> Suggested new private RPC set for `<chain>` (`<environment>`):
>
> 1. `https://healthy-rpc-1.example.com/<redacted>`
> 2. `https://healthy-rpc-2.example.com/<redacted>`
> 3. `https://registry-rpc.example.com/` _(added from registry)_

## Prerequisites

- GCP access for secret RPC URLs (the script reads from GCP Secret Manager)
- `pnpm build` must have been run for `typescript/infra`

## Example Investigation

Alert: "RPC Provider error rate > 60% on stable, provider api-stable-mainnet.n.dwellir.com"

1. Parse: chain=`stable`, environment=`mainnet3`, rpc_provider=`api-stable-mainnet.n.dwellir.com`
2. Run: `cd typescript/infra && pnpm tsx scripts/secret-rpc-urls/debug-rpc-url-health.ts -e mainnet3 -c stable`
3. Output shows 4 private RPCs: 2 ✅, 1 ⚠️, 1 ❌ (the dwellir one)
4. Present:
   - "Provider `api-stable-mainnet.n.dwellir.com` is ❌ — timed out after 5000ms"
   - Full table with all RPCs
   - "Suggest removing 2 unhealthy URLs. 2 healthy private URLs remain (< 3), so adding healthiest registry URL."
   - Show proposed new RPC set

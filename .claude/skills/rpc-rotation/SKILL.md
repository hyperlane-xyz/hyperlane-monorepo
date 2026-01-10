---
name: rpc-rotation
description: Rotates RPC providers when current providers fail. Use when seeing RPC errors, timeouts, rate limiting, or stale block numbers in agent logs.
---

# RPC Provider Rotation

## Test Current RPC

```bash
# Check if RPC responds
cast block-number --rpc-url $(meta <chain> rpc)

# Test latency
time cast block-number --rpc-url "<rpc_url>"
```

## Get Alternative RPCs (Internal)

```bash
# List all RPCs for a chain from GCP secrets
rpcs() {
  gcloud secrets versions access latest \
    --secret="${1:-mainnet3}-rpc-endpoints-${2}" | \
    jq -r 'to_entries | .[] | "\(.key|tonumber+1). \(.value)"'
}

rpcs mainnet3 ethereum
```

## Rotation Steps

1. **Test alternatives**: Run `cast block-number` against each RPC
2. **Update GCP secret**: Reorder RPCs with working one first
   ```bash
   echo '["https://new-primary.rpc", "https://backup.rpc"]' | \
     gcloud secrets versions add "mainnet3-rpc-endpoints-<chain>" --data-file=-
   ```
3. **Restart agent**:
   ```bash
   kubectl rollout restart deployment/hyperlane-relayer -n hyperlane
   ```
4. **Verify**: Check logs for RPC connectivity

## Signs You Need to Rotate

- `RPC error` in logs
- High latency (>5s responses)
- 429 rate limit errors
- Stale block numbers

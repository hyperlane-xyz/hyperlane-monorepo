---
name: debug-stuck-messages
description: Diagnoses stuck or pending Hyperlane messages. Use when a message is not delivered, shows pending status, or when debugging relayer issues.
---

# Debug Stuck Messages

## Step 1: Check Explorer

```bash
curl -s "https://explorer.hyperlane.xyz/api/v1/messages?search=<tx_hash>" | jq '.data[0] | {status, originDomainId, destinationDomainId}'
```

Or visit: `https://explorer.hyperlane.xyz/?search=<tx_hash>`

## Step 2: Identify Root Cause

| Status    | Likely Cause              | Check              |
| --------- | ------------------------- | ------------------ |
| `pending` | Validators haven't signed | Validator health   |
| `pending` | Relayer hasn't picked up  | Relayer logs       |
| `pending` | Gas estimation failing    | Recipient contract |
| `failed`  | Insufficient gas paid     | IGP payment        |

## Step 3: GCP Logs (Internal)

```bash
# Relayer errors for a message
gcloud logging read 'resource.labels.container_name="relayer" jsonPayload.message_id="<id>"' \
  --project=abacus-labs-dev --limit=20

# Chain-specific errors
gcloud logging read 'resource.labels.container_name="relayer" severity>=ERROR jsonPayload.chain="<chain>"' \
  --project=abacus-labs-dev --limit=20
```

## Common Error Patterns

- `CouldNotFetchMetadata` → ISM verification failing, check validators
- `gas estimation failed` → Contract revert, check recipient
- `insufficient funds` → Fund the relayer
- `nonce too low` → Transaction replaced

---
name: debug-stuck-messages
description: Diagnoses stuck or pending Hyperlane messages. Use when a message is not delivered, shows pending status, or when debugging relayer issues.
---

# Debug Stuck Messages

## Step 1: Check Explorer (GraphQL)

```bash
curl -X POST https://explorer4.hasura.app/v1/graphql \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query ($search: String!) { message(where: {_or: [{origin_tx_hash: {_eq: $search}}, {msg_id: {_eq: $search}}]}) { msg_id is_delivered origin_domain_id destination_domain_id origin_tx_hash destination_tx_hash } }",
    "variables": {"search": "<tx_hash>"}
  }' | jq '.data.message[0]'
```

Or visit: `https://explorer.hyperlane.xyz/?search=<tx_hash>`

## Step 2: Identify Root Cause

| Status                | Likely Cause              | Check              |
| --------------------- | ------------------------- | ------------------ |
| `is_delivered: false` | Validators haven't signed | Validator health   |
| `is_delivered: false` | Relayer hasn't picked up  | Relayer logs       |
| `is_delivered: false` | Gas estimation failing    | Recipient contract |
| No destination_tx     | Insufficient gas paid     | IGP payment        |

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

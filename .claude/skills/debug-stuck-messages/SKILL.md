---
name: debug-stuck-messages
description: Diagnoses stuck or pending Hyperlane messages. Use when a message is not delivered, shows pending status, or when debugging relayer issues.
---

# Debug Stuck Messages

## Step 1: Check Explorer (GraphQL)

Query the Hyperlane Explorer GraphQL API. The table is `message_view` and hashes must be prefixed with `\\x` in the query.

```bash
# Query by message ID (replace with actual hash, without 0x prefix)
MSG_ID="638521501e0bfdbea30f882689ec433c9c75e931b88410d72cc2cd8af7823f36"
node -e "const id='$MSG_ID'; console.log(JSON.stringify({query: 'query { message_view(where: {msg_id: {_eq: \"\\\\\\\\x' + id + '\"}}) { msg_id is_delivered origin_domain_id destination_domain_id origin_tx_hash destination_tx_hash sender recipient total_gas_amount total_payment } }'}))" | curl -s -X POST "https://explorer4.hasura.app/v1/graphql" -H "Content-Type: application/json" -d @- | jq '.data.message_view[0]'

# Query by origin transaction hash (replace with actual hash, without 0x prefix)
TX_HASH="3d858acd113529fdbbd781330b575e7a63d00d35a6c0badf36a9a5409ff780ee"
node -e "const id='$TX_HASH'; console.log(JSON.stringify({query: 'query { message_view(where: {origin_tx_hash: {_eq: \"\\\\\\\\x' + id + '\"}}) { msg_id is_delivered origin_domain_id destination_domain_id origin_tx_hash destination_tx_hash sender recipient total_gas_amount total_payment } }'}))" | curl -s -X POST "https://explorer4.hasura.app/v1/graphql" -H "Content-Type: application/json" -d @- | jq '.data.message_view[0]'
```

Or visit: `https://explorer.hyperlane.xyz/?search=<tx_hash>`

### Available Fields in message_view

- `msg_id`, `nonce`, `is_delivered`
- `origin_domain_id`, `destination_domain_id`
- `origin_tx_hash`, `destination_tx_hash`
- `sender`, `recipient`
- `total_gas_amount`, `total_payment`, `num_payments`

### Domain ID Reference

Use the `/chain-metadata` skill to look up domain IDs, or check the registry.

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

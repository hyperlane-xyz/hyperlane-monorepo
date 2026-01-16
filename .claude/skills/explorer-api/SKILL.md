---
name: explorer-api
description: Queries the Hyperlane Explorer GraphQL API for message status and history. Use when checking if a message was delivered, finding stuck messages, or searching by transaction hash.
---

# Hyperlane Explorer API

Query message status via the Explorer GraphQL API.

## GraphQL Endpoint

```
https://explorer4.hasura.app/v1/graphql
```

## Query by Message ID or Transaction Hash

The table is `message_view` and hashes must be prefixed with `\\x` in the query. Remove the `0x` prefix from your hash.

```bash
# Query by message ID (replace with actual hash, without 0x prefix)
MSG_ID="638521501e0bfdbea30f882689ec433c9c75e931b88410d72cc2cd8af7823f36"
node -e "const id='$MSG_ID'; console.log(JSON.stringify({query: 'query { message_view(where: {msg_id: {_eq: \"\\\\\\\\x' + id + '\"}}) { msg_id nonce is_delivered origin_domain_id destination_domain_id origin_tx_hash destination_tx_hash sender recipient total_gas_amount total_payment num_payments } }'}))" | curl -s -X POST "https://explorer4.hasura.app/v1/graphql" -H "Content-Type: application/json" -d @- | jq '.data.message_view[0]'

# Query by origin transaction hash
TX_HASH="3d858acd113529fdbbd781330b575e7a63d00d35a6c0badf36a9a5409ff780ee"
node -e "const id='$TX_HASH'; console.log(JSON.stringify({query: 'query { message_view(where: {origin_tx_hash: {_eq: \"\\\\\\\\x' + id + '\"}}) { msg_id nonce is_delivered origin_domain_id destination_domain_id origin_tx_hash destination_tx_hash sender recipient total_gas_amount total_payment num_payments } }'}))" | curl -s -X POST "https://explorer4.hasura.app/v1/graphql" -H "Content-Type: application/json" -d @- | jq '.data.message_view'
```

## Query Pending Messages by Destination

```bash
# Find undelivered messages to a specific chain (e.g., destination_domain_id = 42161 for Arbitrum)
DEST_DOMAIN="42161"
node -e "const d='$DEST_DOMAIN'; console.log(JSON.stringify({query: 'query { message_view(where: {is_delivered: {_eq: false}, destination_domain_id: {_eq: ' + d + '}}, limit: 20) { msg_id origin_domain_id destination_domain_id sender recipient origin_tx_hash } }'}))" | curl -s -X POST "https://explorer4.hasura.app/v1/graphql" -H "Content-Type: application/json" -d @- | jq '.data.message_view'
```

## Available Fields in message_view

| Field                   | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `msg_id`                | Message ID (hex with `\x` prefix)              |
| `nonce`                 | Message nonce                                  |
| `is_delivered`          | Delivery status (boolean)                      |
| `origin_domain_id`      | Origin chain domain ID                         |
| `destination_domain_id` | Destination chain domain ID                    |
| `origin_tx_hash`        | Transaction hash on origin                     |
| `destination_tx_hash`   | Transaction hash on destination (if delivered) |
| `sender`                | Sender address                                 |
| `recipient`             | Recipient address                              |
| `total_gas_amount`      | Gas used                                       |
| `total_payment`         | IGP payment (wei)                              |
| `num_payments`          | Number of gas payments                         |

## Common Domain IDs

| Chain    | Domain |
| -------- | ------ |
| Ethereum | 1      |
| Optimism | 10     |
| Polygon  | 137    |
| Degen    | 1983   |
| Base     | 8453   |
| Arbitrum | 42161  |

Use the `/chain-metadata` skill to look up domain IDs for other chains.

## Web Interface

You can also search directly at: `https://explorer.hyperlane.xyz/?search=<tx_hash_or_msg_id>`

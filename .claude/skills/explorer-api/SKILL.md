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

## Query by Transaction Hash

```bash
curl -X POST https://explorer4.hasura.app/v1/graphql \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query ($search: String!) { message(where: {_or: [{origin_tx_hash: {_eq: $search}}, {destination_tx_hash: {_eq: $search}}, {msg_id: {_eq: $search}}]}) { id msg_id origin_domain_id destination_domain_id sender recipient is_delivered origin_tx_hash destination_tx_hash } }",
    "variables": {"search": "<tx_hash_or_msg_id>"}
  }' | jq
```

## Query Pending Messages

```bash
curl -X POST https://explorer4.hasura.app/v1/graphql \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query { message(where: {is_delivered: {_eq: false}}, limit: 20, order_by: {send_occurred_at: desc}) { msg_id origin_domain_id destination_domain_id sender recipient origin_tx_hash } }"
  }' | jq
```

## Key Fields

- `msg_id` - Message ID
- `is_delivered` - Delivery status (boolean)
- `origin_domain_id` / `destination_domain_id`
- `origin_tx_hash` / `destination_tx_hash`
- `sender` / `recipient`
- `send_occurred_at` / `delivery_occurred_at`

## Common Domain IDs

| Chain    | Domain |
| -------- | ------ |
| Ethereum | 1      |
| Arbitrum | 42161  |
| Optimism | 10     |
| Polygon  | 137    |
| Base     | 8453   |

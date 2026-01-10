---
name: explorer-api
description: Queries the Hyperlane Explorer API for message status and history. Use when checking if a message was delivered, finding stuck messages, or searching by transaction hash.
---

# Hyperlane Explorer API

Query message status from the Hyperlane Explorer.

## Quick Queries

```bash
# By transaction hash
curl -s "https://explorer.hyperlane.xyz/api/v1/messages?search=<tx_hash>" | jq

# By message ID
curl -s "https://explorer.hyperlane.xyz/api/v1/messages?id=<message_id>" | jq

# By sender/recipient
curl -s "https://explorer.hyperlane.xyz/api/v1/messages?sender=<address>" | jq

# By route (use domain IDs)
curl -s "https://explorer.hyperlane.xyz/api/v1/messages?origin-domain=1&destination-domain=42161" | jq
```

## Common Domain IDs

| Chain    | Domain |
| -------- | ------ |
| Ethereum | 1      |
| Arbitrum | 42161  |
| Optimism | 10     |
| Polygon  | 137    |
| Base     | 8453   |

## Response Fields

- `status`: `delivered`, `pending`, or `failed`
- `originDomainId` / `destinationDomainId`
- `origin.hash` / `destination.hash` - Transaction hashes
- `sender` / `recipient` - Addresses

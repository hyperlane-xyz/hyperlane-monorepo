---
name: bridge-tokens
description: Move inventory tokens between chains via external bridge (LiFi)
allowed-tools: bash read write
---

# Bridge Tokens

Moves the rebalancer's own tokens between chains using an external bridge.
Use this when you need inventory on a chain where you don't have enough.

> For transaction signing and receipt parsing, see the `submit-transaction` skill.

## Bridge Selection Strategy

| Bridge | When to Use             | Delivery             |
| ------ | ----------------------- | -------------------- |
| LiFi   | Production, cross-chain | Poll LiFi status API |
| CEX    | Large amounts           | Manual verification  |

## Production Mode (LiFi API)

See the `rebalance-lifi` skill for LiFi quote + execution flow.

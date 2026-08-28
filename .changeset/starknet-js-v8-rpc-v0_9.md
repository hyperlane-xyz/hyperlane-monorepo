---
'@hyperlane-xyz/starknet-sdk': minor
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/widgets': minor
'@hyperlane-xyz/cli': minor
---

The Starknet TypeScript stack was upgraded from starknet.js v7 to v8.9.2 to support the JSON-RPC v0.9 endpoints. Account, Contract, and ContractFactory call sites were migrated to the v8 options-object constructors, fee estimation was updated to the new resourceBounds shape, and dispatch-event parsing now passes the required ABI parser.

---
'@hyperlane-xyz/starknet-sdk': major
'@hyperlane-xyz/starknet-core': major
'@hyperlane-xyz/sdk': major
'@hyperlane-xyz/utils': major
'@hyperlane-xyz/widgets': major
'@hyperlane-xyz/cli': major
---

The Starknet TypeScript stack was upgraded from starknet.js v7 to v8.9.2 to support the JSON-RPC v0.9 endpoints. Account and Contract call sites were migrated to the v8 options-object constructors, fee estimation was updated to the new resourceBounds shape, and dispatch-event parsing now passes the required ABI parser. Starknet wallet dependencies were upgraded for starknet.js v8 compatibility, and the minimum supported Node.js version is now 22.

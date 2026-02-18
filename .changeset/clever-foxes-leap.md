---
'@hyperlane-xyz/sdk': patch
---

Added multicall3-backed EVM read batching. `MultiProvider.multicall()` accepts array or keyed read-call inputs with automatic fallback to direct RPC. Batch contract lookup now uses known chain addresses while preserving the existing chain metadata schema. Converted EvmIsmReader, EvmRouterReader, EvmWarpRouteReader, and tokenMetadataUtils to use multicall. Added `getTokenBalancesBatch()` utility and `WarpCore.getBalances()` / `WarpCore.getBridgedSupplies()` batch methods.

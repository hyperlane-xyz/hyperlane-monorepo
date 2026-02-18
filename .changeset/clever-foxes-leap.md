---
'@hyperlane-xyz/sdk': patch
---

Added multicall3-backed EVM read batching. `MultiProvider.multicall()` accepts array or keyed read-call inputs with automatic fallback to direct RPC. Chain metadata extended with `batchContractAddress`. Converted EvmIsmReader, EvmRouterReader, EvmWarpRouteReader, and tokenMetadataUtils to use multicall. Added `getTokenBalancesBatch()` utility and `WarpCore.getBalances()` / `WarpCore.getBridgedSupplies()` batch methods.

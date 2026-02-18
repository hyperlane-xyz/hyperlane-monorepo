---
'@hyperlane-xyz/sdk': patch
---

EVM reader paths were migrated to `MultiProvider.multicall`, including router, ISM, warp route, and token metadata reads to reduce RPC round trips while preserving returned config shapes.

---
"@hyperlane-xyz/sdk": patch
---

Added utilities for filtering warp routes by chains: `getChainsFromWarpCoreConfig`, `warpCoreConfigMatchesChains`, and `filterWarpCoreConfigMapByChains`. These enable CLI commands with origin/destination to auto-resolve warp routes when chains uniquely identify a route.

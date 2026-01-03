---
"@hyperlane-xyz/rebalancer": minor
---

Added CollateralDeficitStrategy for just-in-time rebalancing when chains have negative collateral. The strategy detects deficit chains, adds configurable buffer for headroom, and filters pending rebalances by bridge to avoid duplicate transfers.

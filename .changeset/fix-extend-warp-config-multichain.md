---
'@hyperlane-xyz/cli': patch
---

Fix extendWarpConfig test helper to support multi-chain warp routes

The extendWarpConfig helper now reads ALL existing chains from the warp core config instead of just a single chain. This fixes an issue where extending a multi-chain warp route (e.g., 2 chains → 3 chains) would lose configuration for existing chains that weren't explicitly passed to the function.

Changes:
- Updated extendWarpConfig to iterate over all tokens in warpCorePath
- Removed the `chain` parameter (no longer needed)
- Added test for multi-chain extension scenario

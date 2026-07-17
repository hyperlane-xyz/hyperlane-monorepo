---
"@hyperlane-xyz/sdk": patch
---

The EVM warp route check now treats an unset (zero-address) on-chain post-dispatch hook as equivalent to an omitted hook in the deploy config. Previously `expandVirtualWarpDeployConfig` resolved an unset on-chain hook to the zero address while the expected config left it undefined, producing a perpetual false-positive `hook` violation in `check-warp-deploy`. A genuinely configured (non-zero) on-chain hook still surfaces as a violation. This mirrors the existing altVM diff behavior.

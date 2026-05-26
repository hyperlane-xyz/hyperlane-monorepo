---
"@hyperlane-xyz/provider-sdk": minor
---

Added an optional `token` field to `BaseFeeConfig` and `SyntheticWarpArtifactConfig` so the warp orchestrator can thread a paired warp route's settlement asset into the fee config at deploy/update time. Synthetic warps populate the new field post-deploy via their protocol-specific reader/writer. A new `resolveFeeTokenFromWarpArtifactConfig` helper centralizes the resolution rule across `collateral`, `crossCollateral`, `synthetic`, and `native` warps.

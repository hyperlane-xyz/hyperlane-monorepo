---
"@hyperlane-xyz/provider-sdk": minor
"@hyperlane-xyz/deploy-sdk": minor
---

The cross-VM warp orchestrator now populates `config.fee.config.token` from the paired warp route's settlement asset (`resolveFeeTokenFromWarpArtifactConfig`) on both create and update paths. The new `withFeeAssetConfig` helper in `provider-sdk` rebuilds a fee artifact config with the asset set, using explicit per-variant construction so future additions to any fee type break the call site at compile time.

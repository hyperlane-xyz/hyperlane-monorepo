---
"@hyperlane-xyz/provider-sdk": minor
"@hyperlane-xyz/deploy-sdk": minor
"@hyperlane-xyz/sealevel-sdk": minor
---

Added cross-VM plumbing for the warp orchestrator to thread a warp route's settlement asset into its paired fee config at deploy and update time. `BaseFeeConfig` and `SyntheticWarpArtifactConfig` gain an optional `token` field; the SVM synthetic warp reader/writer populates it with the adapter-deployed mint PDA; the deploy-sdk warp orchestrator routes the value through `withFeeAssetConfig` / `resolveFeeTokenFromWarpArtifactConfig` and runs a post-warp-create `feeWriter.update` so per-asset setup (notably SVM beneficiary ATA creation via the new `buildBeneficiaryAtaIx`) happens against the now-resolvable mint.

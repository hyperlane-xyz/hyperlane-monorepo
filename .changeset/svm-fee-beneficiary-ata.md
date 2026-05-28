---
"@hyperlane-xyz/provider-sdk": minor
"@hyperlane-xyz/deploy-sdk": minor
"@hyperlane-xyz/sealevel-sdk": minor
---

Added cross-VM plumbing for the warp orchestrator to thread a warp route's settlement asset into its paired fee config at deploy and update time. `BaseFeeConfig` and `SyntheticWarpArtifactConfig` gain an optional `token` field; the SVM synthetic warp reader/writer populates it with the adapter-deployed mint PDA; the deploy-sdk warp orchestrator deploys the warp first and then the fee with the resolved settlement asset and configured owner, attaching it via the existing update path so per-asset setup (notably SVM beneficiary ATA creation via the new `buildBeneficiaryAtaIx`) runs against the now-known mint. SVM leaf-fee readers return params in bps shape with raw values carried alongside, and `shouldDeployNewFee` is rewritten around a semantic params comparison so apply/enroll round-trips no longer spuriously redeploy the fee.

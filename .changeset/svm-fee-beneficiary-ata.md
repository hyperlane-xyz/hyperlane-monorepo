---
"@hyperlane-xyz/provider-sdk": minor
"@hyperlane-xyz/deploy-sdk": minor
"@hyperlane-xyz/sealevel-sdk": minor
"@hyperlane-xyz/sdk": patch
---

Added cross-VM plumbing for the warp orchestrator to thread a warp route's settlement asset into its paired fee config at deploy and update time:

- `BaseFeeConfig` and `SyntheticWarpArtifactConfig` gain an optional `token` field, populated by the SVM synthetic warp reader/writer with the adapter-deployed mint PDA.
- The deploy-sdk warp orchestrator deploys the warp first, then the fee with the resolved settlement asset, attaching it via the existing update path so per-asset setup (notably SVM beneficiary ATA creation via the new `buildBeneficiaryAtaIx`) runs against the now-known mint.
- SVM leaf-fee readers return params in bps shape with raw values carried alongside, and `shouldDeployNewFee` is rewritten around a semantic params comparison so apply/enroll round-trips no longer spuriously redeploy the fee.
- The SVM fee writers only emit a standalone beneficiary-ATA-create transaction when the ATA does not already exist on-chain (via the new `beneficiaryAtaExists` helper), so a no-op update converges to zero transactions and a fee-bearing deploy no longer force-sends an owner-signed ATA transaction through the deployer signer.
- `computeRemoteRoutersUpdates` keeps the current on-chain destination gas for an existing router when the expected config omits it, instead of zeroing it.
- The altVM branch of `executeWarpDeploy` deploys each warp as the deployer signer (intermediate owner), mirroring the EVM deployer, so post-deploy cross-chain router enrollment stays authorized by the deployer key and ownership is handed to the configured owner during enrollment.

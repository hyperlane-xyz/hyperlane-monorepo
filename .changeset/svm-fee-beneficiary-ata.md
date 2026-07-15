---
"@hyperlane-xyz/provider-sdk": minor
"@hyperlane-xyz/deploy-sdk": minor
"@hyperlane-xyz/sealevel-sdk": minor
"@hyperlane-xyz/sdk": patch
---

Added cross-VM plumbing for the warp orchestrator to thread a warp route's settlement asset into its paired fee config at deploy and update time:

- `BaseFeeConfig` and `SyntheticWarpArtifactConfig` gained an optional `token` field, populated by the SVM synthetic warp reader/writer with the adapter-deployed mint PDA.
- The deploy-sdk warp orchestrator deployed the warp first and then the fee with the resolved settlement asset, attaching it via the existing update path so per-asset setup (notably SVM beneficiary ATA creation via the new `buildBeneficiaryAtaIx`) ran against the now-known mint.
- SVM leaf-fee readers returned params in bps shape with raw values carried alongside, and `shouldDeployNewFee` was rewritten around a semantic params comparison so apply/enroll round-trips no longer spuriously redeployed the fee.
- The SVM fee writers only emitted a standalone beneficiary-ATA-create transaction when the ATA did not already exist on-chain (via the new `beneficiaryAtaExists` helper), so a no-op update converged to zero transactions and a fee-bearing deploy no longer force-sent an owner-signed ATA transaction through the deployer signer.
- `computeRemoteRoutersUpdates` kept the current on-chain destination gas for an existing router when the expected config omitted it (and defaulted to `'0'` for new routers), instead of zeroing it.
- The altVM branch of `executeWarpDeploy` deployed each warp as the deployer signer (intermediate owner), mirroring the EVM deployer, so post-deploy cross-chain router enrollment stayed authorized by the deployer key and ownership was handed to the configured owner during enrollment.

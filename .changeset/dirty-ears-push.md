---
'@hyperlane-xyz/infra': patch
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/sdk': patch
---

Added `shouldRecover` flag to deployContractFromFactory so that the `TestRecipientDeployer` can deploy new contracts if it's not the owner of the prior deployments (We were recovering the SDK artifacts which meant the deployer won't be able to set the ISM as they needed)

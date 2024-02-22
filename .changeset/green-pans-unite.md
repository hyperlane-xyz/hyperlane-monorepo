---
'@hyperlane-xyz/helloworld': minor
'@hyperlane-xyz/infra': minor
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/core': minor
---

Enabled verification of contracts as part of the deployment flow.

- Solidity build artifact is now included as part of the `@hyperlane-xyz/core` package.
- Updated the `HyperlaneDeployer` to perform contract verification immediately after deploying a contract. A default verifier is instantiated using the core build artifact.
- Updated the `HyperlaneIsmFactory` to re-use the `HyperlaneDeployer` for deployment where possible.
- Minor logging improvements throughout deployers.

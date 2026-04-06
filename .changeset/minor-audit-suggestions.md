---
"@hyperlane-xyz/core": minor
---

Addressed minor audit suggestions: renamed `setDestinationConfig` to `addDestinationConfig` in TokenBridgeDepositAddress to prevent accidental overwrites, added `getRemoteInterchainAccount` view to AbstractInterchainAccountRouter, added message type validation in MinimalInterchainAccountRouter, switched to `forceApprove` in TokenRouter fee charging, added zero-amount and same-domain guard checks in CrossCollateralRouter, and restored NatSpec documentation on shared functions.

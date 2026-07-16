---
"@hyperlane-xyz/sdk": patch
---

`EvmTokenAdapter.isApproveRequired`/`isRevokeApprovalRequired` now normalize the `allowance()` result through `BigNumber.from()` before calling `.lt()`/`.isZero()`. Consumers that substitute a non-ethers-v5 provider for a specific chain (e.g. a wallet-derived provider built with a different ethers major version) could get back a value without those methods, causing a `TypeError` (`allowance.isZero is not a function`) instead of a normal boolean result.

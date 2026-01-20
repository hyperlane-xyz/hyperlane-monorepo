---
'@hyperlane-xyz/core': major
---

Refactored InterchainGasPaymaster storage layout to support token-based gas payments. The `destinationGasConfigs` mapping is deprecated and replaced with `tokenGasOracles` and `destinationGasOverhead` mappings. A backward-compatible getter maintains the original ABI signature.

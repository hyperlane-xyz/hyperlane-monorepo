---
"@hyperlane-xyz/sdk": patch
---

The default multisig ISM config for `solanadevnet` was added to `defaultMultisigConfigs`, matching the single-validator (threshold 1) convention used by `solanatestnet` and other low-priority testnets, so that any core deployment or ISM update connecting to solanadevnet as an origin picks up the correct validator set.

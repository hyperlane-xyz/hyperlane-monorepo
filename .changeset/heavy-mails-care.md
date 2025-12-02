---
"@hyperlane-xyz/sdk": minor
---

Fixed the `EV5GnosisSafeTxSubmitter` which failed to create the SAFE transactions due to incorrect typing of the SAFE sdk classes not surfacing incorrect function params when calling `Safe.createTransaction`

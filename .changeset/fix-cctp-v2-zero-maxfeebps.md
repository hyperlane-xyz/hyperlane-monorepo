---
'@hyperlane-xyz/sdk': patch
---

Fixed CCTP V2 deployer to allow maxFeeBps and minFinalityThreshold to be 0 by using explicit undefined checks instead of falsy checks.

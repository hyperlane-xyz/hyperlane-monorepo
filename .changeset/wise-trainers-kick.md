---
'@hyperlane-xyz/sdk': major
'@hyperlane-xyz/infra': patch
---

Fixes a bug where `SealevelHypCollateralAdapter` initialization logic erroneously set the `isSpl2022` property to false.

It updates the `Token.getHypAdapter` and `Token.getAdapter` methods to be async so that before creating an instance of the `SealevelHypCollateralAdapter` class, the collateral account info can be retrieved on chain to set the correct spl standard.

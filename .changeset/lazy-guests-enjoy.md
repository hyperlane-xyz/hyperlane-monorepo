---
'@hyperlane-xyz/utils': minor
'@hyperlane-xyz/sdk': minor
---

Add `WarpCore`, `Token`, and `TokenAmount` classes for interacting with Warp Route instances.

_Breaking change_: The params to the `IHypTokenAdapter` `populateTransferRemoteTx` method have changed. `txValue` has been replaced with `interchainGas`.

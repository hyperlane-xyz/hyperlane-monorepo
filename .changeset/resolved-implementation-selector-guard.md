---
'@hyperlane-xyz/sdk': patch
---

The warp route reader failed `warp read` and `warp check` for routers whose implementation contains a DELEGATECALL byte but no `scale()` or `feeHook()` getter, because the optional calls that the reader then makes against such forwarding code reverted in ways it did not tolerate. The legacy `scale()` read was changed to treat a revert without data as the identity scale, and to treat an empty provider response the same way only when the implementation bytecode does not contain the `scale()` selector, so a getter the bytecode proves present still surfaces an empty response. The LSP17 `NoExtensionFoundForFunctionSelector` revert was recognized as a missing selector, so optional reads such as `feeHook()`, `feeRecipient()` and the xERC20 probe treat it as an absent getter.

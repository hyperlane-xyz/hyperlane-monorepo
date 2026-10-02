---
'@hyperlane-xyz/sdk': patch
---

The warp route reader failed `warp read` and `warp check` for routers whose implementation contains a DELEGATECALL byte but no `scale()` or `feeHook()` getter, because the optional calls that the reader then makes against such forwarding code reverted in ways it did not tolerate. The legacy `scale()` read was changed to tolerate a revert without data as the identity scale, and to tolerate an empty provider response only for a forwarding implementation, while a getter the bytecode proves present, or an empty response from an unresolvable proxy, still surfaces. The LSP17 `NoExtensionFoundForFunctionSelector` revert was recognized as a missing selector, provided the embedded selector matches the call when the call data is known, so optional reads such as `feeHook()`, `feeRecipient()` and the xERC20 probe treat it as an absent getter.

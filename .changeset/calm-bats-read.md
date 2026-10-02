---
"@hyperlane-xyz/sdk": patch
---

The EVM warp route reader now skips xERC20 probing when the wrapped token bytecode does not contain the required selector.

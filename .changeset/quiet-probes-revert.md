---
'@hyperlane-xyz/sdk': patch
---

EVM warp route reads were fixed to treat data-carrying reverts from the xERC20 probe as "not xERC20", to skip the `feeRecipient()` read on routers older than the token fee interface, and to skip the `feeHook()` and legacy `scale()` reads for routers whose bytecode lacks those getters.

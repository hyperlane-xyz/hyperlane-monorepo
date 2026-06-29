---
'@hyperlane-xyz/sdk': minor
---

Added SDK support for IGP fee token oracle configuration and warp route feeHook. The IGP schema now accepts `tokenOracleConfig` for per-ERC20 gas oracle configs, and warp route configs accept `feeHook` for setting the IGP address as a fee hook on TokenRouter. Full pipeline support across deploy, read, update, and check flows.

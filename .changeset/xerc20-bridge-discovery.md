---
'@hyperlane-xyz/sdk': minor
---

xERC20 bridge discovery reports the bridges a token actually holds limits for. Addresses are still collected from the token's events, but the limits are read from the token, and a bridge is no longer required to answer the lockbox `XERC20()` getter, which had dropped every configured bridge that is not a lockbox. Standard xERC20 tokens are discovered through `BridgeLimitsSet` and read through `mintingMaxLimitOf`/`burningMaxLimitOf`, where before only the Velodrome event and getters were consulted. A failed read is no longer classified as a missing selector, so a transient RPC failure surfaces instead of reporting a token with bridges as having none.

`GetExtraLockboxesOptions` gained the optional `warpRouteAddress` and `type`, `EvmEventLogsReader` gained the read-only `getContractDeploymentBlock`, and `deriveXERC20TokenType` throws the new exported `UnknownXERC20TypeError`.

Operators of Standard (non-Velodrome) xERC20 routes must add the token's current `mint` and `burn` to any deploy config that omits `xERC20.warpRouteLimits`, which are now derived and otherwise report a `warp check` violation. Extra bridges are compared as a set, so listing them in a different order to the token's no longer reports a violation.

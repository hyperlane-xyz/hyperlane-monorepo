---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/cli': minor
---

The XERC20 module was extended to read and reconcile ownership in addition to limits. `EvmXERC20Reader` gained `readOwner` and `readProxyAdmin`, `EvmXERC20Module.read()` was updated to surface the token owner and ProxyAdmin owner, and `update()` was changed to append ownership-transfer transactions (for the token's `Ownable` owner and its ProxyAdmin owner) after limit/bridge changes. Expected owners for both the token and its ProxyAdmin were derived from the warp deploy config's top-level `owner`. The `hyperlane xerc20 apply` command was updated to transfer ownership through the same submitter strategy, so XERC20 ownership handoffs no longer require an infra script, and `hyperlane xerc20 read` now reports current owners.

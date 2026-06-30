---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/cli': minor
---

The XERC20 module now reads and reconciles ownership in addition to limits. `EvmXERC20Reader` gained `readOwner` and `readProxyAdmin`, `EvmXERC20Module.read()` surfaces the token owner and ProxyAdmin owner, and `update()` appends ownership-transfer transactions (for the token's `Ownable` owner and its ProxyAdmin owner) after limit/bridge changes. Expected owners are derived from the warp deploy config (`owner`, with `ownerOverrides.collateralToken` / `ownerOverrides.collateralProxyAdmin` taking precedence). The `hyperlane xerc20 apply` command now transfers ownership through the same submitter strategy, so XERC20 ownership handoffs no longer require an infra script, and `hyperlane xerc20 read` reports current owners.

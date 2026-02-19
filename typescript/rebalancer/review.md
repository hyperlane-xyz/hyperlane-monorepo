https://github.com/hyperlane-xyz/hyperlane-monorepo/commit/6baddc5311 (ir-01 LiFiBridge fix)

- instead of passing \_signer: Signer to execute, would it make sense to pass the private key. this way we can avoid having the to set it in the config
- could we pass in chain metadata relevant to the warp route and pull the rpc urls from there instead getChainRpcUrl callback

https://github.com/hyperlane-xyz/hyperlane-monorepo/commit/aea4d70a88 (ir-03 toPublicResults fix)

https://github.com/hyperlane-xyz/hyperlane-monorepo/commit/03f238a9f3 (ir-04 GAS_COST_MULTIPLIER fix)

https://github.com/hyperlane-xyz/hyperlane-monorepo/commit/b8b7822160 (ir-05 HYP_INVENTORY_KEY fix)

- for this fix, could we have not got the inventoryPrivateKey from the inventoryMultiProvider, would this have simplified things?

https://github.com/hyperlane-xyz/hyperlane-monorepo/commit/43cd4709cf (ir-06 Helm + FundableRole fix)

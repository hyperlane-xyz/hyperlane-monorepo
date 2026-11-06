---
'@hyperlane-xyz/rebalancer': minor
---

An optional `pendingTransferMiddlewares` config was added to skip pending transfers that will never be delivered. The `relayerDenylist` middleware applies the relayer runtime denylist, and the `blacklistIsm` middleware applies BlacklistIsms in the destination router's ISM.

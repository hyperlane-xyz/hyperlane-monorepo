---
'@hyperlane-xyz/starknet-sdk': patch
---

Starknet read calls defaulted to the latest accepted block instead of the pending block, so warp token reads no longer fail against RPC providers that reject `block_id: "pending"`.

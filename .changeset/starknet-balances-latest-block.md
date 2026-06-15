---
"@hyperlane-xyz/sdk": patch
---

The default Starknet provider builder now reads at the `latest` block instead of starknet.js's `pending` default, so balance and view calls no longer fail on RPC providers that reject `block_id: "pending"`.

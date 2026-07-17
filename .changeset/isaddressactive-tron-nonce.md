---
"@hyperlane-xyz/sdk": patch
---

`isAddressActive` now checks contract code first and only falls back to the account nonce when the address has no code, guarding the `eth_getTransactionCount` lookup. Chains that don't implement `eth_getTransactionCount` over JSON-RPC (e.g. tron) no longer force a false Inactive verdict for contract owners such as ICAs.

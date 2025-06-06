---
'@hyperlane-xyz/core': major
'@hyperlane-xyz/helloworld': patch
'@hyperlane-xyz/infra': patch
'@hyperlane-xyz/sdk': patch
---

Remove `accountOwners` from `InterchainAccountRouter`

This reverse mapping was intended to index from a given proxy account what the corresponding derivation inputs were.

However, this implied 2 cold SSTORE instructions per account creation.

Instead, the `InterchainAccountCreated` event can be used which now has an `indexed` account key to filter by.

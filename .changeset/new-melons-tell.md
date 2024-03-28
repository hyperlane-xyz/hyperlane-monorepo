---
'@hyperlane-xyz/sdk': minor
---

Fixed an issue where warp route verification would fail at deploy time to a mismatch between the SDK's intermediary contract representation and actual contract name.
Enabled the ContractVerifier to pick up explorer API keys from the configured chain metadat. This allows users to provide their own explorer API keys in custom `chains.yaml` files.

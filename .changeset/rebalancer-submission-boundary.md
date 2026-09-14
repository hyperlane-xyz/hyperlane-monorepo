---
'@hyperlane-xyz/utils': minor
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/tron-sdk': minor
'@hyperlane-xyz/rebalancer': patch
---

Added optional transaction submission observers and typed submission failures so callers could retain execution identities before confirmation. Added a per-call Solana blockhash resubmission control without changing unrelated callers' defaults.

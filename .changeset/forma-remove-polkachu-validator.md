---
"@hyperlane-xyz/sdk": patch
---

Removed the long-inactive Polkachu validator from the forma default multisig ISM config. Polkachu's forma validator has not signed a checkpoint since Feb 2026 (~5 months) as the chain winds down; this drops it from the source-of-truth validator set. The threshold is left unchanged pending a separate on-chain ISM update.

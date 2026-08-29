---
'@hyperlane-xyz/sdk': patch
---

Tron ICA address derivation was moved back to the destination router so its `0x41` CREATE2 prefix is handled correctly, while Ethereum destinations continue to use local derivation.

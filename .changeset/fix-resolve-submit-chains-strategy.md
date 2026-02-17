---
'@hyperlane-xyz/cli': patch
---

Fixed `hl submit` with ICA/timelock strategies failing with missing chain signer errors by extracting all referenced chains from the strategy file in `resolveSubmitChains`.

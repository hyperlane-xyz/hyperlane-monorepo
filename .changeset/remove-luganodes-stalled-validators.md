---
"@hyperlane-xyz/sdk": patch
---

Removed the stalled Luganodes validator from the default multisig ISM configs for unichain and fraxtal, lowering each chain's threshold from 4 to 3 to preserve the minimum majority (`floor(n/2) + 1`) over the remaining 5 validators.

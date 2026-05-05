---
'@hyperlane-xyz/cosmos-sdk': patch
'@hyperlane-xyz/sdk': patch
---

Cosmos fee estimation clients are cached by reusing Stargate client connections across repeated estimates, with cache eviction on failures.

---
'@hyperlane-xyz/tron-sdk': patch
---

Preserved an empty JSON object when querying the Tron solidified head so native API proxies accepted finality reads without falling back to unconfirmed state.

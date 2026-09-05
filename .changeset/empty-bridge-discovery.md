---
'@hyperlane-xyz/rebalancer': patch
---

Skipped Explorer rebalance-action discovery when no bridge addresses were configured, avoiding an empty-result HTTP query while retaining tracked-action delivery checks.

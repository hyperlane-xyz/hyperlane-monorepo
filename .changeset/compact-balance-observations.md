---
'@hyperlane-xyz/metrics': patch
---

Consolidated token balance and USD value into one INFO observation while retaining the separate value event at DEBUG, reducing repeated metric labels in monitor and rebalancer logs.

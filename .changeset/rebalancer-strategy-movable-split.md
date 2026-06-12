---
"@hyperlane-xyz/rebalancer": patch
---

Split rebalancer strategy finalization and movable collateral execution into dedicated modules so route filtering, intent metrics, validation, transaction preparation, chain execution, and result recording can be tested and optimized independently.

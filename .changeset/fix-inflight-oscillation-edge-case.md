---
'@hyperlane-xyz/rebalancer': patch
---

Fixed inventory rebalancer oscillation edge case where an intent with its final deposit fully in-flight (remaining === 0) was invisible to the rebalancer, potentially allowing contradictory intent creation.

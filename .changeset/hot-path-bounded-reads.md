---
'@hyperlane-xyz/utils': patch
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/rebalancer': patch
---

Removed batch barriers from bounded async maps, parallelized independent gas simulation and fee reads, and bounded concurrent rebalancer monitor reads to reduce polling latency. Failed maps stopped scheduling new work and drained active calls before rejecting, preserving backpressure across retries.

Failed inventory or confirmed-block supply reads prevented the monitor from emitting a partial polling cycle, avoiding fabricated zero balances or latest-state supplies in confirmed-block events.

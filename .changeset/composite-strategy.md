---
'@hyperlane-xyz/rebalancer': minor
---

Added CompositeStrategy for chaining multiple rebalancing strategies. Routes from earlier strategies are passed as pending rebalances to later strategies for coordination. Strategy config now uses array format - single strategy is an array with 1 element. Also unified schema types by making bridgeLockTime optional and added name property to IStrategy interface for better logging.

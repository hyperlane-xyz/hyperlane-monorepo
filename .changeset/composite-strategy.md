---
'@hyperlane-xyz/rebalancer': minor
---

Added CompositeStrategy for chaining multiple rebalancing strategies. Routes from earlier strategies were passed as pending rebalances to later strategies for coordination. Strategy config used array format - single strategy is an array with 1 element. Also unified schema types by making bridgeLockTime optional and added name property to IStrategy interface for better logging.

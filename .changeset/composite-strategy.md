---
"@hyperlane-xyz/rebalancer": minor
"@hyperlane-xyz/cli": minor
"@hyperlane-xyz/infra": minor
---

Added CompositeStrategy to chain multiple rebalancing strategies together. The composite executes strategies sequentially, passing routes from earlier strategies as pending rebalances to later ones for coordination. Also exported `getStrategyChainNames` helper to support both single and composite strategy configurations.

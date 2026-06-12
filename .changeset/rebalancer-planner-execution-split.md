---
"@hyperlane-xyz/rebalancer": patch
---

Improved rebalancer planning and execution isolation by passing explicit cycle context to executors, centralizing balance projection and route materialization, resolving route execution config once, and wrapping LiFi SDK calls behind an injected runner with provider-scope execution locks.

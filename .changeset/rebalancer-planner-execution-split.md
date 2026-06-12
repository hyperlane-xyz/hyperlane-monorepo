---
"@hyperlane-xyz/rebalancer": patch
---

Improved rebalancer planning and execution isolation by passing explicit cycle context to executors, centralizing balance projection and route materialization, resolving route execution config once, and wrapping LiFi SDK calls behind an injected runner with provider-scope execution locks. Also normalized route execution configs so stale fields are dropped when overrides change execution type, and made collateral-deficit strategies account for proposed rebalances from earlier composite strategies.

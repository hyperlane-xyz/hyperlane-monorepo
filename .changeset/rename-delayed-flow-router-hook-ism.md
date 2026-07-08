---
'@hyperlane-xyz/core': major
---

The `DelayedFlowRouter` contract and its artifact were renamed to `DelayedFlowRouterHookIsm`, matching the sibling `NetFlowRateLimitedHookIsm` and making its combined hook + ISM role explicit in the name. Downstream imports of the old name must be updated; the contract's behavior, interface, and storage slots are unchanged.

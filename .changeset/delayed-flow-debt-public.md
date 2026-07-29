---
'@hyperlane-xyz/core': minor
---

`DelayedFlowRouterHookIsm` keeps its outstanding over-limit debt in a public `debt` state variable rather than a hashed storage slot, so the unsettled overage is readable on-chain alongside `RateLimited`'s public bucket state.

---
"@hyperlane-xyz/core": minor
---

Native fee refund logic was added to PredicateRouterWrapper to return excess ETH to callers using address(this).balance after the warp route call.

---
"@hyperlane-xyz/core": minor
---

- TVL rate limiters now meter cross-chain transfers in local token units. `NetFlowRateLimitedHookIsm` and `DelayedFlowRouterHookIsm` convert the message (wire) amount to local units via `TvlRateLimited._toLocalAmount` — mirroring `TokenRouter._inboundAmount` (`mulDiv`, round down) — before consuming or crediting the bucket.
- This makes limiters correct for routes whose local decimals differ from the wire format (`scaleNumerator != scaleDenominator`); the amount metered now matches the collateral the router actually moves. `DelayedFlowRouterHookIsm` carries the wire amount cross-chain and converts on each side, so origin and destination meter with their own router's scale.

---
'@hyperlane-xyz/core': minor
'@hyperlane-xyz/sdk': minor
---

The `RateLimited` refill window is made configurable per instance. `RateLimited` now takes a `_duration` constructor argument (previously a hardcoded `1 days` constant), and `RateLimitedHook`, `RateLimitedIsm`, and `DelayedFlowRouter` thread it through. The `DURATION` getter is preserved as a `public immutable` so existing on-chain reads still work. `RateLimitedHookConfig` and `RateLimitedIsmConfig` gain a required `duration` field and the deploy/read paths surface it. Duration is immutable on-chain, so `EvmHookModule` and `EvmIsmModule` warn rather than emit a transaction when the desired duration drifts.

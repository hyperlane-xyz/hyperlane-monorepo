---
'@hyperlane-xyz/core': major
'@hyperlane-xyz/sdk': major
---

The `RateLimited` refill window is made configurable per instance. `RateLimited` now takes a `_duration` constructor argument (previously a hardcoded `1 days` constant), and `RateLimitedHook`, `RateLimitedIsm`, and `DelayedFlowRouterHookIsm` thread it through. The `DURATION` getter is preserved as a `public immutable` so existing on-chain reads still work. `RateLimitedHookConfig` and `RateLimitedIsmConfig` gain a `duration` field: parsing a config that omits it applies a default of 1 day (86400s), matching the previous on-chain window, but the field is present on the exported (inferred) config types, so TypeScript callers constructing these configs must supply it. The deploy/read paths surface it. Duration is immutable on-chain, so `EvmHookModule` and `EvmIsmModule` redeploy a fresh `RateLimited` hook/ISM when the desired duration changes.

---
'@hyperlane-xyz/sdk': minor
---

The `ERC20_FEE_AGGREGATION_HOOK_VERSION` constant, naming 11.0.1 as the first `@hyperlane-xyz/core` version that unambiguously identifies a `StaticAggregationHook` accepting ERC20 fee metadata (11.0.0 shipped the fix, but hooks built without it already reported 11.0.0), was exported together with the `getTxConfigBatchSize` helper and the `submitRoutingHookConfigs` helper, which sends routing hook `setHooks` configs in transactions sized per chain. `HyperlaneHookDeployer` was changed to send its routing hook configs through `submitRoutingHookConfigs`.

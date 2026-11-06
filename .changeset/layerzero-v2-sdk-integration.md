---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/relayer': minor
'@hyperlane-xyz/cli': patch
---

Support for the combined `LayerZeroV2HookIsm` hook/ISM router was added:

- The SDK gained `EvmLayerZeroV2HookIsmModule` and `EvmLayerZeroV2HookIsmReader`, the `layerZeroV2Hook` and `layerZeroV2Ism` config types, and Warp helpers that paired the hook and ISM leaves of a route into one mesh. One router was deployed per chain with its offchain lookup URLs, and every other chain was enrolled with its LayerZero endpoint ID, send and receive libraries, Executor config and send and receive ULN configs.
- Pathway configs were typed: each Executor and ULN config was either `default`, which inherited the library's mutable default, or `override`, whose fields replaced the default individually. Every enrollment wrote the complete policy, encoding defaults as all-zero configs, so a reset to `default` or a library change never left an old override active. Reads reported the app configs and, separately, the effective configs after LayerZero applied the defaults.
- The `expandNonDeployableHookIsms` reader option covered LayerZero hooks and ISMs, so LayerZero ISMs nested in aggregation and routing ISMs were derived as typed configs for Warp reads and relayer metadata.
- `warp deploy` deployed and enrolled the mesh before the Warp routers, and `warp apply` reused compatible routers and added the enrollment and URL updates for reused routers to the apply transactions. `warp check` compared the enrolled LayerZero peers and endpoint IDs with the deployed counterparts, in addition to the pathway libraries and policy.
- The relayer built CCIP-read metadata, `(receiveLibrary, packet)`, for the LayerZero router.

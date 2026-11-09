---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/relayer': minor
'@hyperlane-xyz/cli': minor
---

Support for the combined `LayerZeroV2HookIsm` hook/ISM router was added:

- The SDK gained `EvmLayerZeroV2HookIsmModule` and `EvmLayerZeroV2HookIsmReader`, the `layerZeroV2Hook` and `layerZeroV2Ism` config types, and Warp helpers that paired the hook and ISM leaves of a route into one mesh. One router was deployed per chain with its offchain lookup URLs, and every other chain was enrolled with its LayerZero endpoint ID, send and receive libraries, Executor config and send and receive ULN configs.
- Pathway configs were typed: each Executor and ULN config was either `default`, which inherited the library's mutable default, or `override`, whose fields replaced the default individually. Every enrollment wrote the complete policy, encoding defaults as all-zero configs, so a reset to `default` or a library change never left an old override active. Reads reported the app configs and, separately, the effective configs after LayerZero applied the defaults.
- The `expandNonDeployableHookIsms` reader option covered LayerZero hooks and ISMs, so LayerZero ISMs nested in aggregation and routing ISMs were derived as typed configs for Warp reads and relayer metadata.
- `warp deploy` deployed and enrolled the mesh before the Warp routers, and `warp apply` reused compatible routers and added the enrollment and URL updates for reused routers to the apply transactions. `warp check` compared the enrolled LayerZero peers and endpoint IDs with the deployed counterparts, in addition to the pathway libraries and policy.
- The relayer built CCIP-read metadata, `(receiveLibrary, packet)`, for the LayerZero router.
- The pairing and materialization of combined hook/ISM leaves were shared between Wormhole and LayerZero. `pairCombinedHookIsmConfigs` and `materializeCombinedHookIsmWarpConfig` took the protocol's leaf matcher, `WORMHOLE_LEAF_MATCHER` or `LAYER_ZERO_V2_LEAF_MATCHER`, and `collectHookAddresses` and `collectIsmAddresses` collected the addresses of derived hook and ISM trees.
- `EvmLayerZeroV2HookIsmModule.reconcileMesh` logged a warning naming every replaced router. Packets of messages dispatched through a replaced router named it as their sender or receiver, so they could not be verified once its replacement was installed, and transfers had to be paused and pending messages delivered before the returned transactions were submitted.
- `EvmLayerZeroV2HookIsmModule` unenrolled remote routers whose domain was not in the registry by their numeric domain ID.
- `EvmLayerZeroV2HookIsmModule.deployMesh` and `reconcileMesh` checked, before deploying anything, that the LayerZero domain ID of every pathway matched the ID reported by the remote chain's Endpoint.
- LayerZero ISMs read by `EvmIsmReader`, and so by `warp read`, included the effective send and receive configs of every pathway, showing the DVNs, confirmations and Executor that secured a `default` pathway. `warp check` ignored these read-only values and compared the configured pathway policy.
- The CLI examples gained `examples/layerzero/layerzero-warp-route.yaml`, a two-chain Warp route secured by the LayerZero hook/ISM. Its comments described the pathway fields, the configured and effective configs reported by `warp read`, and that `confirmations: 0` in a ULN override required zero confirmations instead of inheriting the library default.

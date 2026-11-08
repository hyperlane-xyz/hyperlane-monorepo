---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/relayer': minor
'@hyperlane-xyz/cli': patch
---

Support for the combined `WormholeVaaHookIsm` hook/ISM router was added:

- The SDK gained `EvmWormholeHookIsmModule` and `EvmWormholeHookIsmReader`, the `wormholeHook` and `wormholeIsm` config types, and Warp helpers that paired the hook and ISM leaves of a route into one mesh. One router was deployed per chain, every other chain was enrolled with its Wormhole chain ID and the consistency level, custom base level and additional blocks it published with, and both leaves were replaced with the same local address before generic Warp processing.
- `EvmHookReader` and `EvmIsmReader` gained an `expandNonDeployableHookIsms` option. Warp route reads enabled it on both readers, so Wormhole hooks nested in aggregation, routing, fallback-routing and amount-routing hooks, and Wormhole ISMs nested in aggregation, routing and amount-routing ISMs, were derived as typed configs. The relayer enabled it on its ISM reader to build metadata for nested Wormhole ISMs; other readers kept them as addresses.
- Custom consistency levels were required to use a standard base level and at least one additional block.
- Wormhole consistency levels matched the values the router accepted. A router published at `zeroFinalized` (0), `instant` (200), `safe` (201), `finalized` (202) or `custom` (203). An enrolled remote router was expected at any of those levels or at the Solana VAA levels 1 (confirmed) and 32 (finalized), listed in `WormholeVaaConsistencyLevel` and validated by `WormholeVaaConsistencyLevelSchema`. Custom base levels stayed limited to `instant`, `safe` and `finalized`. Every level was read back and re-encoded to the same value.
- `warp deploy` deployed and enrolled the mesh before the Warp routers. `warp apply` reused compatible routers, redeployed routers whose immutable settings changed, and added the enrollment and URL updates for reused routers to the apply transactions. `warp check` reported drift in the enrolled remote routers, and reported each chain whose Wormhole hook and ISM were missing, duplicated or not the same router while still checking the enrollments between the remaining chains.
- The relayer built CCIP-read metadata for the Wormhole router and included `origin_tx_hash` in CCIP-read POST requests, so a lookup service could find the origin transaction without the Explorer.

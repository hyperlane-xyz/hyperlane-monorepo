---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/relayer': minor
'@hyperlane-xyz/cli': patch
---

Support for the combined `WormholeVaaHookIsm` hook/ISM router was added:

- The SDK gained `EvmWormholeHookIsmModule` and `EvmWormholeHookIsmReader`, the `wormholeVaaHook` and `wormholeVaaIsm` config types, and Warp helpers that paired the hook and ISM leaves of a route into one mesh. One router was deployed per chain, every other chain was enrolled with its Wormhole chain ID and the consistency level, custom base level and additional blocks it published with, and both leaves were replaced with the same local address before generic Warp processing.
- Custom consistency levels were required to use a standard base level and at least one additional block.
- `warp deploy` deployed and enrolled the mesh before the Warp routers. `warp apply` reused compatible routers, redeployed routers whose immutable settings changed, and added the enrollment and URL updates for reused routers to the apply transactions. `warp check` reported drift in the enrolled remote routers.
- The relayer built CCIP-read metadata for the Wormhole router and included `origin_tx_hash` in CCIP-read POST requests, so a lookup service could find the origin transaction without the Explorer.

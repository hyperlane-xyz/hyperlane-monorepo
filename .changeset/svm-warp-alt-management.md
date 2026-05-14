---
"@hyperlane-xyz/sealevel-sdk": minor
---

A per-token-type ALT management surface for SVM warp routes was added. Each token type (native, collateral, synthetic, cross-collateral) gets a reader + writer pair (e.g. `SvmNativeTokenAltReader` / `SvmNativeTokenAltWriter`); the reader owns `deriveWarpRouteAddresses`, `read`, and `check` and only needs a `SealevelAddressLookupTableReader`, while the writer adds `create` and requires the signer-backed `SealevelAddressLookupTableWriter`. Dispatch-by-type is exposed through `SvmWarpAltManager.createWriter(type)` and `SvmWarpAltReader.createReader(type)`, built via the public `createWarpAltManager` / `createWarpAltReader` factories that accept `ChainMetadataForAltVM`. Each writer's `create` emits two frozen ALTs — a chain-shared `core` bucket (mailbox + IGP) and a `warpSpecific` bucket (warp PDAs + plugin static + fee/IGP cascades).

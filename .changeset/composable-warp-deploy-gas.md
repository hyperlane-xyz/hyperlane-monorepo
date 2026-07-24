---
'@hyperlane-xyz/provider-sdk': major
'@hyperlane-xyz/sdk': major
'@hyperlane-xyz/sealevel-sdk': major
'@hyperlane-xyz/tron-sdk': major
'@hyperlane-xyz/cosmos-sdk': major
'@hyperlane-xyz/aleo-sdk': major
'@hyperlane-xyz/radix-sdk': major
'@hyperlane-xyz/starknet-sdk': major
'@hyperlane-xyz/cli': minor
---

- `getMinGasForWarpDeploy` now lives on `IProvider` (per-chain) instead of the stateless `ProtocolProvider`. It is `async` and returns a FINAL native-denom amount rather than a mix of gas units and native amounts. It composes the base router deploy cost with additive deltas for detected features (cross-collateral extras, fee program deploy, custom ISM / hook / IGP deploy) driven by the warp config shape, and for gas-metered protocols multiplies gas units by the chain gas price.
- `ChainMetadataForAltVM` gained an optional `gasPrice` field.
- `ProviderBuilderFn` now takes a full `ChainMetadata` instead of `(rpcUrls, network)`.
- The AltVM `IProvider.connect` and `ISigner.connectWithSigner` static factories now take `ChainMetadataForAltVM` as their first argument, replacing the previous `(rpcUrls, chainId, extraParams)` shape and the metadata-through-`extraParams` indirection.
- The CLI warp-deploy preflight now sizes AltVM native-balance requirements from the composed per-chain deploy cost, so feature-heavy deploys are no longer silently under-funded, and chains without a gas price are no longer skipped for the warp-deploy path.
- The AltVM warp-deploy base gas costs were calibrated from measured deploys (Sealevel from mainnet; Starknet, Aleo, and Radix from devnet base-router floors with safety margin), replacing the previous catastrophically-low placeholder constants that let preflight pass under-funded accounts.
- The Starknet test fixture native token was corrected from ETH to STRK to match the production registry and the token the devnet actually charges fees in.

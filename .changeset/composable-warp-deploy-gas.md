---
'@hyperlane-xyz/provider-sdk': minor
'@hyperlane-xyz/sealevel-sdk': minor
'@hyperlane-xyz/tron-sdk': minor
'@hyperlane-xyz/cosmos-sdk': minor
'@hyperlane-xyz/aleo-sdk': minor
'@hyperlane-xyz/radix-sdk': minor
'@hyperlane-xyz/starknet-sdk': minor
'@hyperlane-xyz/cli': minor
---

A new `ProtocolProvider.getMinGasForWarpDeploy(warpConfig)` method was added and implemented in every AltVM SDK. Unlike the flat `getMinGas().WARP_DEPLOY_GAS` constant — which sizes only the base router deploy — the new method composes the base cost with additive deltas for detected features (cross-collateral extras, fee program deploy, custom ISM / hook / IGP deploy) driven by the `WarpConfig` shape. Sealevel now carries observed deltas from live cross-collateral + fee-program deploys (~2.6 SOL base + ~1.1 SOL crossCollateral + ~2.5 SOL fee program). The CLI's warp-deploy preflight balance check was wired to consult the composable value per AltVM chain, so feature-heavy deploys are no longer silently under-funded.

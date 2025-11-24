---
"@hyperlane-xyz/provider-sdk": minor
"@hyperlane-xyz/cosmos-sdk": minor
"@hyperlane-xyz/deploy-sdk": minor
"@hyperlane-xyz/radix-sdk": minor
"@hyperlane-xyz/cli": minor
"@hyperlane-xyz/sdk": minor
---

Add `chainId` and `rpcUrls` to `ChainMetadataForAltVM`. Add `CosmosNativeProtocolProvider` and `RadixProtocolProvider` to both cosmos-sdk and radix-sdk, respectively. Add `forWarpRead`, `forCoreRead`, and `forCoreCheck` to signerMiddleware to enable chain resolving for these CLI functions. Add `assert` after some `altVmProvider.get` calls in SDK configUtils.

---
"@hyperlane-xyz/provider-sdk": minor
"@hyperlane-xyz/deploy-sdk": minor
"@hyperlane-xyz/sealevel-sdk": patch
"@hyperlane-xyz/cosmos-sdk": patch
"@hyperlane-xyz/radix-sdk": patch
"@hyperlane-xyz/starknet-sdk": patch
"@hyperlane-xyz/aleo-sdk": patch
"@hyperlane-xyz/tron-sdk": patch
---

Multi-VM fee type support was added to provider-sdk and deploy-sdk. Fee types (linear, regressive, progressive, offchainQuotedLinear, routing, crossCollateralRouting) were defined with Config API and Artifact API variants. FeeReader and FeeWriter with required FeeReadContext were added to deploy-sdk. Fee was integrated into warp types and the warp writer update flow. All protocol providers received createFeeArtifactManager stubs.

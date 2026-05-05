---
'@hyperlane-xyz/provider-sdk': major
'@hyperlane-xyz/deploy-sdk': major
'@hyperlane-xyz/sealevel-sdk': minor
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/aleo-sdk': patch
'@hyperlane-xyz/cosmos-sdk': patch
'@hyperlane-xyz/radix-sdk': patch
'@hyperlane-xyz/starknet-core': patch
'@hyperlane-xyz/cli': patch
---

SVM fee program management was added to the SVM SDK with full create, read, and update support for all 6 fee types (linear, regressive, progressive, offchainQuotedLinear, routing, crossCollateralRouting). The provider-sdk fee types were refactored with a FeeParams discriminated union (bps vs raw), PascalCase FeeType/FeeStrategyType values, expanded DerivedFeeConfig with resolved bigint fields, and a required FeeReadContext parameter on createFeeArtifactManager. Shared BPS fee utilities (computeBps, bpsToRawFeeParams, constants) were consolidated into provider-sdk as the single source of truth — sdk and svm-sdk now import from provider-sdk. The EVM SDK TokenFeeType was converted from enum to const object for structural compatibility. Legacy pre-fee program bytes were preserved for upgrade testing.

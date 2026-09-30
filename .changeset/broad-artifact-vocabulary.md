---
'@hyperlane-xyz/aleo-sdk': patch
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/cosmos-sdk': patch
'@hyperlane-xyz/deploy-sdk': patch
'@hyperlane-xyz/infra': patch
'@hyperlane-xyz/provider-sdk': major
'@hyperlane-xyz/radix-sdk': patch
'@hyperlane-xyz/sdk': major
'@hyperlane-xyz/sealevel-sdk': patch
'@hyperlane-xyz/starknet-sdk': patch
'@hyperlane-xyz/utils': minor
---

The provider artifact vocabulary was expanded to cover every SDK hook, ISM, and token discriminator while retaining partial protocol implementations. Custom ISMs detected through the AltVM interface were normalized to opaque unknown artifacts. The SDK discriminator catalogs were replaced with provider SDK aliases to prevent future drift, while EVM-specific IGP recovery metadata remains SDK-owned. Known non-empty artifact collections now use a shared non-empty array type, OP L1 bridge versions are constrained to supported variants, and CCTP version-specific fields are modeled as a discriminated union. Hook conversion now preserves protocol-agnostic IGP deployment metadata, and artifact merging respects constructor-immutable fields on otherwise mutable rate-limited artifacts. Artifact mutability and static-type helpers are now imported directly from the provider SDK instead of being re-exported by the EVM SDK.

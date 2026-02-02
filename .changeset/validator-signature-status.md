---
"@hyperlane-xyz/sdk": major
---

**BREAKING**: `MetadataBuilder.build()` now returns `MetadataBuildResult` instead of `string`. Access `.metadata` on the result to get the encoded bytes.

Added real-time validator signature status to MetadataBuilder. The builder now returns detailed information about which validators have signed a message, their checkpoint indices, and actual signatures. New exports: `ValidatorInfo`, `MetadataBuildResult`, `DerivedHookConfig`, and helper functions `isMetadataBuildable()`, `getSignedValidatorCount()`, `isQuorumMet()`.

Performance optimizations:
- EvmIsmReader routing ISM derivation reduced from ~5.7s to ~724ms via messageContext short-circuit
- EvmHookReader RPC calls parallelized across all derivation methods
- SmartProvider retry logic fixed to correctly identify permanent errors

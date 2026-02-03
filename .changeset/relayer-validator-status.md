---
"@hyperlane-xyz/relayer": minor
---

**BREAKING**: `MetadataBuilder.build()` now returns `MetadataBuildResult` instead of `string`. Access `.metadata` on the result to get the encoded bytes.

Added real-time validator signature status to MetadataBuilder. The builder now returns detailed `ValidatorInfo` for each validator including signing status ('signed' | 'pending' | 'error'), checkpoint indices, and actual signatures. Aggregation and routing ISMs return nested results for sub-modules. New helper functions: `isMetadataBuildable()`, `getSignedValidatorCount()`, `isQuorumMet()`.

---
"@hyperlane-xyz/relayer": major
---

**BREAKING**: `MetadataBuilder.build()` return type changed from `string` to `MetadataBuildResult`. Access `.metadata` on the result to get the encoded bytes.

Added real-time validator signature status to MetadataBuilder. The builder returns detailed `ValidatorInfo` for each validator including signing status ('signed' | 'pending' | 'error'), checkpoint indices, and actual signatures. Aggregation and routing ISMs return nested results for sub-modules. Added helper functions: `isMetadataBuildable()`, `getSignedValidatorCount()`, `isQuorumMet()`.

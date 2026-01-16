---
'@hyperlane-xyz/aleo-sdk': minor
---

Implemented hook artifact API for Aleo. Added hook query functions, transaction builders, and artifact readers/writers for IGP and MerkleTree hooks. The AleoHookArtifactManager provides factory methods for creating type-specific hook readers and writers, with optional mailbox address that is validated only when creating writers for deployment. Hook writers support creating new hooks and updating mutable configurations (IGP owner and gas configs). Existing provider implementation was refactored to use the new shared query and transaction functions, reducing code duplication. Comprehensive e2e tests verify all hook operations following the established artifact API patterns.

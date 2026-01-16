---
'@hyperlane-xyz/cosmos-sdk': minor
---

Implemented hook artifact API for Cosmos. Added hook query functions, transaction builders, and artifact readers/writers for IGP and MerkleTree hooks. The CosmosHookArtifactManager provides factory methods for creating type-specific hook readers and writers using lazy query client initialization. Hook writers support creating new hooks and updating mutable configurations (IGP owner and gas configs). Existing provider and signer implementations were refactored to use the new shared query and transaction functions, reducing code duplication. Comprehensive e2e tests verify all hook operations following the established artifact API patterns.

---
'@hyperlane-xyz/cosmos-sdk': minor
---

Implemented warp artifact API for supported Cosmos warp tokens. A CosmosWarpArtifactManager class was added that provides factory methods for creating readers and writers for collateral and synthetic warp tokens. The implementation includes query helpers for reading token configuration, transaction builders for creating and updating tokens, and comprehensive e2e tests. The CosmosNativeProvider was refactored to use the extracted warp functions, reducing code duplication.

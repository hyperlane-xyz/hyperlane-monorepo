---
'@hyperlane-xyz/cosmos-sdk': minor
---

Implemented ISM writers using the new artifact API for Cosmos. Added CosmosTestIsmWriter, CosmosMessageIdMultisigIsmWriter, CosmosMerkleRootMultisigIsmWriter, and CosmosRoutingIsmRawWriter classes. These writers support creating and updating ISMs on Cosmos chains, with routing ISM supporting full domain route management and ownership transfers. The CosmosIsmArtifactManager now provides functional createWriter() factory methods for all supported ISM types.

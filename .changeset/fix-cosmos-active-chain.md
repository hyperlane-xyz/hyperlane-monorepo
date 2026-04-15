---
"@hyperlane-xyz/widgets": patch
---

Fix Cosmos transfers failing with "must be connected to origin chain" by reverting useCosmosActiveChain to return empty ActiveChainInfo, since CosmosKit doesn't have the concept of an active chain

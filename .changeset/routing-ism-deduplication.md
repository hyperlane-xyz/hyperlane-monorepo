---
'@hyperlane-xyz/provider-sdk': patch
'@hyperlane-xyz/radix-sdk': patch
'@hyperlane-xyz/cosmos-sdk': patch
'@hyperlane-xyz/aleo-sdk': patch
---

Routing ISM logic extracted into pure functions in provider-sdk. `computeRoutingIsmDomainChanges` computes domain route changes for updates, while `routingIsmQueryResultToArtifact` transforms chain query results into artifacts. Protocol SDKs use these functions instead of duplicating transformation logic, eliminating ~450 lines of duplicated code across radix-sdk, cosmos-sdk, and aleo-sdk.

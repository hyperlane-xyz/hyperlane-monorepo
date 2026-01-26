---
'@hyperlane-xyz/sdk': minor
---

Added optional `blockTag` parameter to `getBridgedSupply()` method in `IHypTokenAdapter` interface and all EVM adapter implementations. This allows querying bridged supply at a specific block height or using block parameter tags (finalized, safe, latest, etc.).

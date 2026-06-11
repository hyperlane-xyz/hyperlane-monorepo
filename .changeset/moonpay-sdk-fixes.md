---
"@hyperlane-xyz/sdk": patch
---

EvmTokenFeeDeployer caching is disabled so each sub-fee contract (e.g. every OffchainQuotedLinearFee inside a RoutingFee) receives its own deployment instead of sharing an address.

HyperlaneJsonRpcProvider normalizes an empty-string `to` field to null on GetTransaction/GetTransactionReceipt responses, fixing an "invalid address" error thrown by ethers.js for contract-creation transactions on RPCs that return `""` instead of `null`.

deriveTokenMetadata now propagates the `scale` field from the warp route config.

sortArraysInConfig is fixed to handle non-object array elements (e.g. plain strings) without throwing when accessing `.type`.

---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/utils': patch
---

Renamed the validator quorum RPC verification config fields to make clear they only add to, rather than replace, a chain's `rpcUrls`. `AgentChainMetadataSchema`'s `quorumRpcUrls` and `customQuorumRpcUrls` are now `additionalQuorumRpcUrls` and `customAdditionalQuorumRpcUrls`. `ValidatorMetadata.quorum_rpcs` is now `additional_quorum_rpcs`. This is a breaking rename with no backwards-compatible alias, since these fields shipped very recently and have no known external consumers yet.

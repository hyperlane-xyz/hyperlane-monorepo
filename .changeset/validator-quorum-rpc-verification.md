---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/utils': patch
---

Added validator quorum RPC verification support. `AgentChainMetadataSchema` gained an optional `quorumRpcUrls` array (mirroring `rpcUrls`) alongside the existing `customQuorumRpcUrls` override, so a chain's statically configured quorum pool can be expressed in typed config rather than only via the comma-separated override string. `ValidatorMetadata.rpcs` was widened to `Array<string | ValidatorMetadataRpcEntry>` to cover both the historical (pre-agents-v1.6.0) flat hash-string wire shape and the current `{ url_hash, host_hash }` object shape, since metadata blobs are unversioned and a rolling validator fleet can publish either. A new `validatorMetadataRpcUrlHash` helper narrows an `rpcs` entry to its URL hash regardless of which shape it was serialized in. `ValidatorMetadata` also gained an optional `quorum_rpcs` field, reported separately from `rpcs`.

---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/utils': minor
---

Added validator lightweight mode for trusted websocket indexing across supported protocols, with every state-read endpoint checked against local roots at its own message index and signing limited to the common verified history. Removed RPC indexing fallback and startup RPC tree downloads in lightweight mode. Removed the separate `additionalQuorumRpcUrls` / `customAdditionalQuorumRpcUrls` configuration and `additional_quorum_rpcs` validator metadata; operators can move those endpoints into `rpcUrls` / `customRpcUrls`.

---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/utils': minor
---

Added validator lightweight mode for trusted websocket indexing across supported protocols, with every state-read endpoint checked against local roots at its own message index and signing limited to the common verified history. Removed RPC indexing fallback and startup RPC tree downloads in lightweight mode. Rejected obsolete additional-quorum settings in both validator modes to require explicit endpoint migration into `rpcUrls` / `customRpcUrls`. Bounded checkpoint RPC retries despite websocket notifications and coordinated snapshot restoration with websocket replay in both modes. Moved historical uploads for every lightweight batch into one background worker while preserving complete snapshot coverage. Removed `additional_quorum_rpcs` validator metadata.

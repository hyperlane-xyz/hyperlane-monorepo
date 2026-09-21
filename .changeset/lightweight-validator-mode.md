---
'@hyperlane-xyz/sdk': major
'@hyperlane-xyz/utils': major
---

Added validator lightweight mode for trusted websocket indexing across supported protocols, with a fixed two-thirds majority of configured state-read endpoints required to authenticate local insertion history. Signed through the highest message index supported by that majority, tolerated minority endpoint failures or disagreements, and preserved normal-mode RPC behavior. Removed RPC indexing fallback and startup RPC tree downloads in lightweight mode. Rejected obsolete additional-quorum settings in both validator modes to require explicit endpoint migration into `rpcUrls` / `customRpcUrls`. Bounded checkpoint RPC retries despite websocket notifications and coordinated snapshot restoration with websocket replay in both modes. Moved historical uploads for every lightweight batch into one background worker while preserving complete snapshot coverage. Removed `additional_quorum_rpcs` validator metadata.

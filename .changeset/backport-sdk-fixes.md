---
'@hyperlane-xyz/sdk': patch
---

SmartProvider was updated to skip retry and stagger fanout for SendTransaction to prevent nonce errors. ISM factory now simulates deploy address via eth_call when getAddress() is incorrect. MultiProvider was updated to cache connected signers. Warp deploys were changed to disable concurrency for Tron. Defensive null guards were added across MultiProvider, EvmEventLogsReader, xerc20, and RPC log parsing. HyperlaneCore onDispatch errors are now caught and logged.

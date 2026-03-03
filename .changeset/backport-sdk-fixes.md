---
'@hyperlane-xyz/sdk': patch
---

SmartProvider skips retry and stagger fanout for SendTransaction to prevent nonce errors. ISM factory simulates deploy address via eth_call when getAddress() is incorrect. MultiProvider caches connected signers. Warp deploys disable concurrency for Tron. Defensive null guards added across MultiProvider, EvmEventLogsReader, xerc20, and RPC log parsing. HyperlaneCore onDispatch errors are caught and logged.

---
'@hyperlane-xyz/sdk': patch
---

Fixed Tron EthersV5 provider to use TronJsonRpcProvider (which appends `/jsonrpc` to the RPC URL) instead of HyperlaneSmartProvider, preventing 302 redirect failures on Tron nodes.

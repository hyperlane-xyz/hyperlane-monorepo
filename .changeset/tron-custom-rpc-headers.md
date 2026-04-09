---
"@hyperlane-xyz/tron-sdk": patch
---

TronJsonRpcProvider and TronTransactionBuilder now parse custom_rpc_header query params into HTTP headers, fixing auth with third-party RPC providers like Tatum.

---
'@hyperlane-xyz/sdk': patch
---

SmartProvider was updated to skip retry and stagger fanout for SendTransaction to prevent nonce errors from duplicate submissions. SendTransaction now breaks out of the provider fallback loop on any error. GetGasPrice and GetTransactionCount were excluded from etherscan routing.

---
'@hyperlane-xyz/tron-sdk': minor
'@hyperlane-xyz/sdk': minor
---

Tron Virtual Machine (TVM) support added to the Hyperlane SDK. The new `@hyperlane-xyz/tron-sdk` package provides `TronJsonRpcProvider`, `TronWallet`, and `TronContractFactory` for interacting with Tron chains. The SDK deployers now automatically use Tron-compiled factories for Create2-affected contracts (ISM/hook factories, ICA router) when deploying to Tron chains.

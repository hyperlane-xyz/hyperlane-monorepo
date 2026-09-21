---
'@hyperlane-xyz/sdk': major
---

Added lightweight validator configuration and the validator `majority` RPC consensus option. Removed `additionalQuorumRpcUrls` and `customAdditionalQuorumRpcUrls`. Existing configs must move those endpoints into the protocol's primary RPC pool (`rpcUrls`/`customRpcUrls` for EVM).

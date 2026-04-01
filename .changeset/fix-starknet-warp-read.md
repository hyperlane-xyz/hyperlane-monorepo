---
'@hyperlane-xyz/starknet-sdk': patch
---

Fixed on-chain token metadata reading for Starknet chains by fetching the contract's actual ABI instead of using a hardcoded HYP_ERC20 artifact. Proxy contracts are now resolved to their implementation class ABI, and `shouldFallbackStorageRead` was unified into a shared utility so both protocol-fee and validator-announce managers handle the same set of RPC errors (including `-32000` / "method not allowed").

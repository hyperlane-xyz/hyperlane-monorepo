---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/tron-sdk': minor
---

Extended `WarpCore` rate-limit validation to cover Tron xERC20 warp-route standards (`TronHypVSXERC20`, `TronHypVSXERC20Lockbox` and `TronHypCollateralFiat`) by matching against the shared `XERC20_STANDARDS` set instead of enumerating EVM standards inline.

Hardened the Tron SDK ethers adapters. Native contract reads and the ethers-to-Tron transaction conversion now share a single `triggerTronContractCall` helper, removing the duplicated request-building and result-asserting logic and fixing calldata serialization so `BytesLike` inputs are hex-encoded rather than stringified. Receipt confirmation is now bounded by a timeout so a broadcast transaction that is never mined rejects loudly with its txid instead of polling forever, and the synthesized ethers `TransactionReceipt` is constructed without unsafe casts.

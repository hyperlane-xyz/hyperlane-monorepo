---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/tron-sdk': minor
---

Extended `WarpCore` rate-limit validation to cover Tron xERC20 warp-route standards (`TronHypVSXERC20`, `TronHypVSXERC20Lockbox` and `TronHypCollateralFiat`) by matching against the shared `XERC20_STANDARDS` set instead of enumerating EVM standards inline. The destination mint-limit check now compares capacity in message space using each router's `scale` (mirroring `isDestinationCollateralSufficient`) rather than converting decimals only, and the origin burn-limit check now accounts for the origin-token-denominated fees included in the on-chain burn debit.

Hardened the Tron SDK ethers adapters. Native contract reads and the ethers-to-Tron transaction conversion now share a single `buildTronTriggerRequest` helper for request construction, fixing calldata serialization so `BytesLike` inputs are hex-encoded rather than stringified. Contract reads now POST directly to the raw `wallet/triggerconstantcontract` full-node endpoint instead of TronWeb's `triggerConstantContract` wrapper, which throws and discards the return data on a reverted read; the raw endpoint returns the reverted or empty data (`0x`) so ethers can recognize a missing selector, mirroring `eth_call`. Receipt confirmation is now bounded by a timeout so a broadcast transaction that is never mined rejects loudly with its txid instead of polling forever, and the synthesized ethers `TransactionReceipt` is constructed without unsafe casts.

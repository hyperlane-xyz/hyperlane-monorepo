---
"@hyperlane-xyz/tron-sdk": patch
---

Fixed a bug where a Tron transaction that broadcast successfully but reverted on-chain was silently treated as a success by the ethers-compatible `TronWallet`. The `wait` returned by `getTransactionResponse` delegated to ethers' stock `waitForTransaction`, which resolves the receipt without the status-0 revert throw ethers only injects for EVM. It now fetches the transaction's execution info via `getTransactionInfo` and throws a descriptive `Tron Transaction Failed` error on a reverted/failed transaction, matching EVM's `CALL_EXCEPTION` behavior. The revert-detection logic was extracted into a shared `assertTronReceiptSuccess` helper reused by both `TronWallet` and the AltVM `TronProvider.waitForTransaction` path, whose behavior is unchanged.

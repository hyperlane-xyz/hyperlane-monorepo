---
'@hyperlane-xyz/tron-sdk': minor
'@hyperlane-xyz/sdk': patch
---

Tron externally-owned accounts are no longer reported as inactive owners. `TronJsonRpcProvider` gained `isAccountActive`, which reads on-chain activation from the native `wallet/getaccount` endpoint instead of leaving liveness to be inferred from `getTransactionCount` (Tron has no nonces, so that method is hardcoded to 0 and made every Tron EOA look dead). `isAddressActive` now consults that method when the provider offers it and otherwise keeps its existing code-or-nonce behaviour, so `warp check` stops emitting a permanent `ownerStatus` violation for live Tron EOA owners. A failure reaching the Tron node is thrown rather than reported as inactive.

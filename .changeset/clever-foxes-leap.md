---
'@hyperlane-xyz/sdk': patch
---

Added `getTokenBalancesBatch()` and `WarpCore` batch helpers (`getBalances` and `getBridgedSupplies`) so token balance and bridged-supply reads are grouped per chain with multicall-backed EVM reads and individual-call fallbacks.

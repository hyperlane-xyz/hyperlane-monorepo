---
'@hyperlane-xyz/tron-sdk': patch
'@hyperlane-xyz/rebalancer': patch
---

Approval receipt deadlines were kept on the original transaction waiter, preserving ethers replacement handling and Tron HTTP confirmation behavior while removing timed-out listeners. Tron receipt waits gained an optional per-call timeout.

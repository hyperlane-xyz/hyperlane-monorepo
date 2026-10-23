---
"@hyperlane-xyz/rebalancer": patch
---

Separated ERC20 approval submission errors and callbacks from primary source transfers. Recorded locally signed approval hashes before broadcasting and retained their identity across ambiguous responses and receipt failures.

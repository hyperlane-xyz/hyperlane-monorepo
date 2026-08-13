---
"@hyperlane-xyz/ccip-server": patch
---

Hardened calls commitment reconciliation by rejecting conflicting retries, returning stored ICA metadata, and atomically persisting EVM calldata with its legacy commitment.

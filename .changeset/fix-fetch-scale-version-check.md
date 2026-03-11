---
"@hyperlane-xyz/sdk": patch
---

Fixed fetchScale version gate to compare against the contract version where scaling was first introduced (6.0.0) instead of the fraction scaling version (11.0.0), preventing failed scale() reads on pre-scaling contracts.

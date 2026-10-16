---
'@hyperlane-xyz/rebalancer': patch
---

Disabled chains are now filtered out of the metadata passed to external bridge adapters, preventing duplicate chainId collisions from deprecated/unavailable registry entries.

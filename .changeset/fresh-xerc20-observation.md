---
'@hyperlane-xyz/metrics': patch
---

Resolved the xERC20 address once per limit observation instead of repeating the same read for each limit and label. Preserved fresh address and limit reads on every monitoring cycle.

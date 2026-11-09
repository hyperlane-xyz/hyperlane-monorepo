---
'@hyperlane-xyz/sdk': patch
---

Added support for fractional-second polling intervals in chain indexing and validator checkpoint configuration, allowing operators to poll fast chains more frequently. Intervals must be at least 0.01 seconds (10 ms). Existing whole-second settings and defaults were preserved.

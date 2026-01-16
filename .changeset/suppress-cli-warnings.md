---
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/rebalancer': patch
'@hyperlane-xyz/warp-monitor': patch
---

Suppressed harmless warnings that appeared during startup: the bigint-buffer native bindings warning and the node-fetch DeprecationWarning about .data property. The warnings are now filtered at the start of the bundle before any modules load.

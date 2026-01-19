---
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/rebalancer': patch
'@hyperlane-xyz/warp-monitor': patch
---

Suppressed harmless startup warnings via pnpm patches instead of runtime suppression. The bigint-buffer native bindings warning and node-fetch .data deprecation warning are now patched at the source, avoiding the need for --no-warnings flags or console.warn overrides.

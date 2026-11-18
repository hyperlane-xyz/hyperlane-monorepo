---
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/rebalancer': patch
'@hyperlane-xyz/relayer': patch
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/utils': patch
'@hyperlane-xyz/widgets': patch
---

The yaml dependency was updated from 2.4.5 to 2.9.1, which fixes a stack overflow when parsing deeply nested YAML collections (GHSA-48c2-rrv3-qjmp).

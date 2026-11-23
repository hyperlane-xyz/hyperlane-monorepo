---
'@hyperlane-xyz/deploy-sdk': patch
'@hyperlane-xyz/provider-sdk': patch
'@hyperlane-xyz/rebalancer': patch
'@hyperlane-xyz/relayer': patch
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/sealevel-sdk': patch
---

The minimum zod version was raised to 4.6.7, which bounds memory use when validating oversized constrained collections (GHSA-mrhx-c7xc-m3w5).

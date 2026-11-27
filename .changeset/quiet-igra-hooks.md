---
'@hyperlane-xyz/sdk': patch
---

Fixed warp deployment failures for custom hooks reporting the UNUSED type, including hooks nested in aggregations, by preserving them as unknown hooks with their deployed addresses.

---
'@hyperlane-xyz/aleo-sdk': patch
---

Fixed Aleo synthetic warp deployments to derive remote decimals from the configured scale instead of always using local decimals. Invalid scales and decimal ranges were rejected before deployment.

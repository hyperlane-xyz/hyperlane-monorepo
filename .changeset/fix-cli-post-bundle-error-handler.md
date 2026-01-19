---
'@hyperlane-xyz/cli': patch
---

Fixed broken error handler in ncc.post-bundle.mjs that referenced undefined variables in the catch block.

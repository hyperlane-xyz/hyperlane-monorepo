---
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/infra': patch
---

Fixed import cycles by extracting shared code into separate modules and removing unnecessary re-exports.

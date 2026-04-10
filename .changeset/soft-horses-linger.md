---
'@hyperlane-xyz/sealevel-sdk': patch
---

The sealevel ISM deploy flow was hardened by waiting for deployed programs to become visible and retrying initialization on chains that acknowledge deploys before the program is invokable.

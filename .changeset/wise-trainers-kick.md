---
'@hyperlane-xyz/sdk': major
'@hyperlane-xyz/infra': patch
---

Fixes the SealevelHypCollateralAdapter initialization logic by updating the getHypAdapter and getAdapter methods to be async so that before creating an instance of the class, the right spl token standard can be set.

---
'@hyperlane-xyz/ccip-server': patch
---

Reveal lookups in the call commitments service were changed:

- The origin transaction hash is required.
- Calls are only returned for reveals sent between registry ICA routers, when the commitment sent with the reveal matches the stored ICA. Other reveals receive HTTP 403.
- The service fails to start if the registry lists no ICA routers.

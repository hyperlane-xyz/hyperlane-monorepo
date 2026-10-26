---
'@hyperlane-xyz/sdk': patch
---

Routing ISMs were initialized with their final owner when all routes fit in the deployment batch, avoiding a separate ownership transfer that lagging RPCs could underestimate before observing the deployed contract.

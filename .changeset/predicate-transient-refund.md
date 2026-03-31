---
"@hyperlane-xyz/core": minor
---

PredicateRouterWrapper was updated to use transient storage for the pending attestation flag, eliminating cold SLOAD/SSTORE costs. Native fee refund logic was added to return excess ETH to callers.

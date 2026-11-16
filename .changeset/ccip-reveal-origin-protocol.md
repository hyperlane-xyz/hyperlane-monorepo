---
'@hyperlane-xyz/ccip-server': patch
---

Reveal lookups were made dependent on the origin protocol. Sealevel-origin ICA reveals were served from the stored commitment, regardless of transaction hash format, only when `CCS_SEALEVEL_REVEALS_ENABLED` was set to `true`, and were rejected with HTTP 403 otherwise. EVM reveals required a valid 32-byte origin transaction hash and received HTTP 400 without one; unknown and unsupported origin protocols were rejected.

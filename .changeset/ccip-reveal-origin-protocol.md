---
'@hyperlane-xyz/ccip-server': patch
---

Fixed Sealevel-origin ICA reveals to use the stored commitment regardless of transaction hash format. EVM reveals now require a valid 32-byte origin transaction hash; unknown and unsupported origin protocols are rejected.

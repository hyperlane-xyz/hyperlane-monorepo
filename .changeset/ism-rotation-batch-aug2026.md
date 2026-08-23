---
"@hyperlane-xyz/sdk": patch
---

Rotated all Abacus Works validators in the default multisig ISM configs to the new shared GCP-backed signing key (`0xa5962efa3ec138bf7ca8f7fde86b7ee32e24bf03` on mainnet chains, `0x3c659e0fe8d01b80d7828b421630085777346e7c` on testnet chains). Also removed stalled operators from default ISMs: Luganodes from solanamainnet (3-of-4) and berachain (3-of-4), Stakecito from forma (threshold 4 to 3), and Everclear from blast (threshold 3 to 2).

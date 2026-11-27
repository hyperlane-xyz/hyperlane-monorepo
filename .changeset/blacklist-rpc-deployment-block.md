---
'@hyperlane-xyz/sdk': minor
---

The legacy BlacklistIsm reader now falls back to the RPC to resolve the contract deployment block when the block explorer lookup fails, so blacklist ISMs remain readable on chains without a getcontractcreation-capable explorer. The blacklist log scan also uses a wide pagination range so it completes over RPC on chains without a log-serving explorer.

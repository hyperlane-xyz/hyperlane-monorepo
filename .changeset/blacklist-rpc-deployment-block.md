---
'@hyperlane-xyz/sdk': minor
---

The legacy BlacklistIsm reader now falls back to scanning MessageBlacklisted logs from genesis over the RPC when the block explorer cannot supply the contract deployment block, so blacklist ISMs stay readable on chains without a getcontractcreation-capable explorer. The explorer-derived deployment block remains the authoritative lower bound; the reader no longer bisects historical eth_getCode over the RPC to derive one, which could converge above the true deployment block on pruned nodes and silently drop earlier blacklisted IDs. The log scan also uses a wide pagination range so it completes over the RPC and fails closed rather than returning a partial set.

---
"@hyperlane-xyz/sdk": patch
---

Fixed EVM ISM and hook derivation to rethrow transient RPC failures during interface probes instead of silently returning incorrect derived configs.

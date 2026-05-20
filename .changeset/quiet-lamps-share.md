---
"@hyperlane-xyz/sdk": patch
---

Fixed EVM ISM, hook, ICA, and warp-route derivation to rethrow transient RPC failures during interface probes instead of silently returning incorrect derived configs.

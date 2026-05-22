---
"@hyperlane-xyz/sdk": patch
---

Fixed EVM ISM, hook, ICA, and warp-route derivation to rethrow transient RPC failures during interface probes instead of silently returning incorrect derived configs. Configured routing hook children now fail fast when child hook derivation fails instead of being silently omitted.

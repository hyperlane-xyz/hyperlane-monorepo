---
'@hyperlane-xyz/infra': patch
---

Warp checker now gracefully handles deprecated chains instead of failing. Chains not in supportedChainNames are skipped, and missing RPC secrets fall back to public RPCs from the registry.

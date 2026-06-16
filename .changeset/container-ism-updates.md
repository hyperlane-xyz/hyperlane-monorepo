---
"@hyperlane-xyz/sdk": patch
---

Fixed container ISM in-place updates by falling back to redeploys when aggregation sub-module matching is ambiguous and by preflighting child updates before address-preserving recursion.

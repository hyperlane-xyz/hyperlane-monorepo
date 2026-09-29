---
'@hyperlane-xyz/sdk': patch
---

SmartProvider keeps an empty-response failure as the cause when another provider times out, so empty-response missing-selector handling no longer depends on provider latency.

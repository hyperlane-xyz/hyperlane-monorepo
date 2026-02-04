---
'@hyperlane-xyz/utils': patch
'@hyperlane-xyz/sdk': patch
---

The arrow wrapper in fetchWithTimeout was replaced with a bound method to prevent closure from capturing surrounding scope and keeping large objects alive for the lifetime of the AbortSignal timeout. Removed duplicate dead code from SDK.

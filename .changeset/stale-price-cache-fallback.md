---
'@hyperlane-xyz/sdk': patch
---

Added stale-cache fallback to CoinGecko token price fetcher. When the API returns errors (e.g. 429 rate limiting), previously cached prices are returned instead of undefined, preventing metrics from going stale.

---
'@hyperlane-xyz/rebalancer': patch
---

Coalesced concurrent CoinGecko lookups for the same token ID, reducing duplicate metrics price requests while preserving cache expiry and retries after failures.

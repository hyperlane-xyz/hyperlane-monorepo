---
'@hyperlane-xyz/sdk': patch
---

CoinGeckoTokenPriceGetter now routes authenticated (pro) API keys to the dedicated pro-api.coingecko.com host instead of the public host that ignores the key, and the inter-request delay is only applied when a request actually hits the network rather than on cache hits. A batched, fault-tolerant prefetchTokenPrices method and a cache-only getCachedTokenPrice reader were added so callers can warm many token prices in one chunked pass and then read individual prices without issuing a request per token.

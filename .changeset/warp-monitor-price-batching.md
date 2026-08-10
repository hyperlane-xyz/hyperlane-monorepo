---
'@hyperlane-xyz/sdk': patch
---

CoinGeckoTokenPriceGetter now sends the API key as an `x-cg-pro-api-key` header against the pro host (`pro-api.coingecko.com`) instead of an `x-cg-pro-api-key` query parameter against the public host. The query-parameter form returned 401, and the public host rejects the pro key with HTTP 400; the header-against-pro-host form authenticates correctly and also keeps the secret out of logged URLs. The inter-request delay is now only applied when a request actually hits the network rather than on cache hits. A batched, fault-tolerant prefetchTokenPrices method and a cache-only getCachedTokenPrice reader were added so callers can warm many token prices in one chunked pass and then read individual prices without issuing a request per token.

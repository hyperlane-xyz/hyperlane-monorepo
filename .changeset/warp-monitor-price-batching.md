---
'@hyperlane-xyz/sdk': patch
---

CoinGeckoTokenPriceGetter now sends the API key as an `x-cg-demo-api-key` header against the public host instead of an `x-cg-pro-api-key` query parameter. The query-parameter form left demo-tier keys unauthenticated (rate limited as anonymous) and also leaked the key into logged URLs; the header form authenticates correctly and keeps the secret out of logs. The inter-request delay is now only applied when a request actually hits the network rather than on cache hits. A batched, fault-tolerant prefetchTokenPrices method and a cache-only getCachedTokenPrice reader were added so callers can warm many token prices in one chunked pass and then read individual prices without issuing a request per token. Chunks are sized to the demo tier's 4-ids-per-call limit on /simple/price, since a larger id list is rejected with HTTP 400 and would otherwise drop the whole batch.

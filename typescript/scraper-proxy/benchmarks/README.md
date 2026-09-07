# Cached GraphQL request benchmark

`src/scripts/benchmark-cache-plugin.ts` exercises request normalization and Apollo execution with the production validation rule. Queries use one root field, no aliases and 50 or 250 total fields; both sizes are within production limits. Each variant warms 100 requests and times 1,000 cache hits, three times. Every result is checked and the resolver must execute exactly once per server.

This is synthetic cached-request processing on Node 24.13.0, without HTTP transport, a database, realistic result sizes or concurrent clients. It does not measure deployed request latency or service capacity.

## Reproduce

After a frozen workspace install and building scraper-proxy dependencies, run from this package directory:

```sh
pnpm exec tsx src/scripts/benchmark-cache-plugin.ts
```

To compare the implementation before this change, temporarily place its module alongside its relative imports:

```sh
git show 58e16ce8:typescript/scraper-proxy/src/scraperdb/cache-plugin.ts > src/scraperdb/cache-plugin.benchmark-baseline.ts
pnpm exec tsx src/scripts/benchmark-cache-plugin.ts src/scraperdb/cache-plugin.benchmark-baseline.ts
rm src/scraperdb/cache-plugin.benchmark-baseline.ts
```

The optional argument loads a trusted local benchmark module. No production service imports this script.

## Local measurements, 2026-09-05

Elapsed milliseconds per 1,000 requests, including identical response assertions:

| Total fields | Baseline runs          | Current runs           | Median reduction |
| ------------ | ---------------------- | ---------------------- | ---------------- |
| 50           | 205.30, 201.63, 200.37 | 79.05, 77.19, 74.89    | 61.7%            |
| 250          | 816.16, 802.76, 813.01 | 298.48, 301.19, 300.61 | 63.0%            |

The deterministic change is two cache-key reparses and two prints per reused document/request becoming zero after the first document preparation. Request normalization still parses/prints each request; variables still sort/serialize and hash on every request. Result-cache TTL, refresh and size limits remain unchanged.

The WeakMap adds a normalized query string and used-variable set per reachable cached document. Entries become collectible with their documents, instead of retaining every query ever seen. Production document-cache eviction and result-cache hit rate determine the benefit; neither was measured here.

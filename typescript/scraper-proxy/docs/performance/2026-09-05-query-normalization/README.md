# GraphQL query normalization cache

## Problem

HTTP compatibility middleware calls `stripUnusedVariableDefinitions` before Apollo handles each request. Repeated query text is parsed, visited and printed even when Apollo's document and response caches are warm. The earlier cache-plugin metadata optimization does not cover this middleware work.

## Solution

Cache exact query text to its normalized text. Keep 64 entries in access order, each with at most 8,192 combined input/output UTF-16 code units: at most 1 MiB of string content, excluding object/Map overhead. Parse failures and oversized pairs are not cached. Cache misses use the unchanged parser/visitor/printer.

Variables, operation names, authentication, database rows and responses are not cached here. Existing multi-operation normalization behavior, validation, response TTL, refresh requests and error handling remain unchanged.

## Performance evidence

Local Node 24.13.0, one process, four alternating parent/head pairs per case, 100 warmups and 1,000 measured requests per variant. The harness runs the actual compatibility function and Apollo execution with the existing response-cache plugin and validation rule. It asserts identical complete response data, no errors and one resolver call per server. HTTP, database I/O and profiler instrumentation are excluded.

| Fields | Query text workload      | Parent median / 1,000 | Head median / 1,000 |
| ------ | ------------------------ | --------------------: | ------------------: |
| 50     | Eight repeated texts     |              80.93 ms |            14.02 ms |
| 250    | Eight repeated texts     |             333.94 ms |            54.04 ms |
| 50     | Fresh text every request |              79.37 ms |            81.67 ms |
| 250    | Fresh text every request |             327.60 ms |           330.36 ms |

Repeated-text cases take **82.7% and 83.8% less local processing elapsed time**. Fresh-text controls show **2.9% and 0.8% overhead**, not a speedup. The text variants differ in comments and normalize to the same document; repeated mode cycles through eight exact inputs, while fresh mode never reuses an input. Field counts include the root field and stay within existing validation limits.

These are synthetic request traces, not measured production hit rates or end-to-end latency improvements. Existing service activity establishes that the middleware runs, but no live query-text repetition denominator was measured. Full samples are in `results.json`.

## Reproduction

From this checkout, with its locked dependencies and built dependencies available:

```sh
mkdir -p typescript/scraper-proxy/dist
git show a4c4943e9781f1722f65f9e3818ac1dc0968d332:typescript/scraper-proxy/src/scraperdb/request-compatibility.ts > typescript/scraper-proxy/dist/request-compatibility.baseline.ts
pnpm --filter @hyperlane-xyz/scraper-proxy exec tsx src/scripts/benchmark-query-normalization.ts dist/request-compatibility.baseline.ts
```

The baseline compatibility file has only a GraphQL dependency, so both variants use the identical installed parser and current Apollo/cache-plugin code. No network or database fixture is needed.

## Validation

All 70 scraper-proxy tests passed. Focused cache cases verify parser work reuse, LRU eviction, batch/non-string inputs, variable/operation independence, malformed inputs, oversized source text, and combined input/output size rejection. Build, lint and changed-file formatting passed. Independent source review found no blockers.

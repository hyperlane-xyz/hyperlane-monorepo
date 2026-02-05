---
'@hyperlane-xyz/utils': minor
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/cosmos-sdk': patch
'@hyperlane-xyz/http-registry-server': patch
'@hyperlane-xyz/relayer': patch
---

A `LazyAsync` helper was added to `@hyperlane-xyz/utils` for safe, deduplicated async initialization. It replaces the scattered pattern of `if (!cached) { cached = await init(); } return cached` with an approach that deduplicates concurrent callers, clears state on errors to allow retries, and supports reset capability. Consumer packages were migrated to use this utility.

---
'@hyperlane-xyz/utils': minor
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/cosmos-sdk': patch
'@hyperlane-xyz/http-registry-server': patch
'@hyperlane-xyz/relayer': patch
---

A `LazyAsync` helper was added to `@hyperlane-xyz/utils` for safe, deduplicated async initialization. It replaces the scattered pattern of `if (!cached) { cached = await init(); } return cached` with a thread-safe approach that handles concurrent callers, configurable error caching, and reset capability. Consumer packages were migrated to use this utility.

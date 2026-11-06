# Default ISM classifier and post-fetch TTL API

Landed by runtime_recovery:

- `contract_cache.CacheFor(Address).DefaultIsmFetch.now_ms_fn: ?*const fn (*anyopaque) anyerror!u64 = null`.
- `defaultIsmFor(..., now_ms)` still looks up at the supplied timestamp. After successful `fetch.get(now_ms)`, insertion uses `now_ms_fn(fetch.context)` if present; missing/failed clock falls back to the original supplied timestamp. A clock failure cannot fail a successful RPC. The callback MUST use the same clock domain as lookup.
- NEW `relayer/app_context.zig.classify(comptime Address, root, explicit:?[]const u8, cache:?*CacheFor(Address).Cache, context:contract.Context, fetch:DefaultIsmFetch, now_ms)![]const u8`.
- Explicit matching app returns immediately without default RPC. Otherwise default lookup is strict (ordinary RPC error, PIO, cancellation, refusal and OOM propagate); successful equality returns `default_ism`, inequality `Unknown`. Null cache still performs the actual getter. This helper does not depend on an observer being installed.

Native Factory.metadataInner now resolves this once before both Builder paths, passes resolved context to CachedSource.setMessage and Builder.app_context, so children inherit metadata ROOT context. Existing operation/queue plain-app classification is unchanged.

Native Factory uses raw monotonic Instant nanoseconds/milliseconds already used by active_cache_ms for BOTH default lookup and callback insertion. It does NOT insert process-relative or UTC milliseconds into that raw-domain cache. Existing metered-cache timing is unchanged. EVM metadata owner should use its own process-relative observation clock consistently for its separate EVM default cache; deterministic missing-clock callers retain the supplied timestamp.

Metadata owner still owns EVMPreparer, CachedSource, source_metadata and Builder. CachedSource policy-only default getters should populate the callback where an actual clock is available, because explicit-app classification can skip default lookup yet configured default-ISM cache selectors may still fetch it.

Focused tests at app_context_tests.zig cover explicit precedence/no lookup, strict ordinary/PIO failure, successful default and Unknown classification, Source600000ms expiry measured after a slow simulated successful fetch, clock failure fallback and null-cache strictness. Actual native Factory existing explicit-app path will be rerun through permanent native tests.

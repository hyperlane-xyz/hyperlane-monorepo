# Scraper CPU/SQL diagnostic

Scope: two single-Zig local diagnostic trials, not matched Rust/Zig timing benchmarks. Both use production Solidity fixtures, disposable Anvil, PostgreSQL16, the21 actual migrations,100 catch-up events plus10 fresh events and same-port restart. Host was nonquiet; each trial includes intrusive macOS `/usr/bin/sample` at1ms for5s. Raw harness timing fields must not be used for generalized performance claims.

## Concrete causes and fixes

1. RPC Pool idle-wait optimization had inadvertently removed its active2ms wait. Active requests consequently busy-looped through curl_multi_perform and clocks. Restored the2ms condition timed wait while active, retaining indefinite idle condition wait and immediate submit/cancel wakeups. No source cadence, peer strategy, endpoint denominator or concurrency change.
2. Short scraper PG leases unconditionally repeated a two-GUC timeout SELECT. Role pools now initialize immutable statement_timeout/lock_timeout defaults only on a fresh/recovered connection while leased exclusively. Each lease still rebinds its actual absolute client deadline/cancellation; configuration failure closes the partially initialized connection. Standalone pools without defaults retain explicit configure behavior. Conflicting configured service timeouts reject construction.

## Observed attribution

| Evidence | Before | After |
| --- | ---: | ---: |
| Scraper timeout-setting SQL round trips, actual PG statement log |494|8|
| `net.curl_multi.Multi.poll` collapsed top-stack samples |952|11|
| `evm.pool.Pool.run` collapsed top-stack samples |338|7|
| `mach_continuous_time` collapsed top-stack samples |700|5|
| `mach_absolute_time` collapsed top-stack samples |399|5|

Sample counts are observations from all process threads, not CPU-time percentages, syscall counts, or equal-work wall-clock comparison. Wait stacks dominate after the fix. PostgreSQL total logged statements include fixture-harness queries; only the timeout SELECT count is scraper-attributed here. No production service or key access.

## Verification

- Active socket polling regression2/2; full RPC strategy tests77 passed,1 optional skipped.
- Native PG run357 passed,10 optional skipped,1 unrelated cache-retirement assertion failed (`relayer.evm_source_cache_tests.native cooperative discovery completes past stall and releases resources`: expected0 found1), reported to parent owner.
- New native session initialization test passed: pre-canceled acquire opens no connection; fresh and recovered sessions both carry2s statement/lock defaults; a50ms client deadline still interrupts pg_sleep(5), poisons the old connection, and reconnects with a new backend PID.
- Both diagnostic trials pass full catch-up/fresh-row/restart checks. Expanded whole-process fault/liveness regression is running separately.

Artifacts: `/tmp/ziggy-scraper-diagnostic/`, `/tmp/ziggy-scraper-diagnostic-after/`, `/tmp/ziggy-scraper-session-config-pg-results/`. Fixed binary `/tmp/ziggy-scraper-diagnostic-fixed`; final matched measurements remain gated on an explicitly coordinated quiet window.

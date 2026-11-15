# Configured Sealevel unavailable blocks

The configured managed RPC pool discarded Sealevel skipped/pruned-block errors
before the scraper could use its existing sparse-slot search and basic event
metadata fallback. The actual before reproduction failed with
AllRpcProvidersFailed; the same configured range now progresses from unavailable
slot 10 to canonical slot 9.

The correction retains one quota-charged original error envelope. It returns that
envelope only after the existing retry policy is exhausted, every configured
provider has been attempted, and every relevant failure has a recognized
unresolvable getBlock code. A later healthy block wins normally. Mixed transport,
HTTP, schema, health-probe or rate-limit failures cannot authorize skipped-slot
progress. Cancellation, deadlines, allocation failures and quorum semantics
retain their separate paths.

| Final focused root                     | ReleaseSafe | ReleaseFast | Substantive / import roots |
| -------------------------------------- | ----------: | ----------: | -------------------------: |
| Configured Cosmos absence              |   18 passed |   18 passed |                     7 / 11 |
| Configured Sealevel unavailable blocks |   16 passed |   16 passed |                     12 / 4 |

All four logs have zero skips. Counts belong to overlapping test roots and must
not be summed as unique coverage. The Sealevel controls include real configured
Resources/Pool and scraper callers, both-provider retries, later healthy results,
mixed failures, cancellation/deadlines, retained-response quota and an induced
allocation failure with exact allocation/free balance after the owner joins.
The failure-injection allocator is synchronized across owner/caller threads.

[Sealevel diagnostic archive](../../zig/bench/results/configured-svm-unavailable/manifest.json)
preserves the actual before failure, intermediate failures, the earlier 15-test
snapshot and final 16-test results. Its
[verification](../../zig/bench/results/configured-svm-unavailable/archive-verification.json)
records original-file and gzip readback.

[Combined final archive](../../zig/bench/results/configured-pool-final-20261107/manifest.json)
contains all four final commands/logs/results, eight immutable source copies,
91 preserved pins, owner freeze handoff, Root readback and the closed independent
review. Its [verification](../../zig/bench/results/configured-pool-final-20261107/archive-verification.json)
confirms byte-exact decompression and unchanged originals. Earlier independent
review notes remain historical; the final report closes the synchronized OOM
fixture change and binds all final bytes.

Root subsequently added the two permanent database-test imports and committed
nine files under normal hooks as
d51ca8d668b26a3fdd248b4dfa99609bdcd6e493. That aggregate import is archived
separately from the eight-file focused source snapshot. Fresh full suites and
corrected role builds are still required before another actual native case.

These are native loopback component results. They grant no actual native-chain,
600-second lifecycle or performance acceptance. All originals remain local;
no executable, database, WAL or cache was copied or deleted.

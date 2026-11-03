# Rust hot-path experiments

These are synthetic, paired experiments against actual production methods at
`7e80c603f0278c9b1f0555fe0106279e2df5f070` (before) and
`d555ffbfd7d82438851e6f848ea7dfc28b2e336d` (after). They measure the effect of
concurrency under controlled RPC delays. They do not establish production
latency, sustainable throughput, RPC quotas, or host-resource savings.

The runner retrieves the old production source with `git show`; it does not
transcribe the old algorithm. Both implementations execute in the same test
binary, using the same fixtures and workload definitions. The proposed method
runs directly from the package source. The runner verifies its production-prefix
hash against the proposed SHA before building.

Only original test modules and an inner documentation comment are removed from
the generated baseline source. Two scraper methods receive `pub(super)`
visibility for the harness; their bodies remain unchanged. Source and harness
hashes, adjustments, commands, compiler version, and host information are in
`results/manifest.json`. Build logs and executable paths stay in the temporary
output directory; the checked-in manifest is curated after measurement.

The build temporarily appends a test-module declaration to each owned source
file, then restores the exact original bytes in `finally`, including on a failed
build. Concurrent modifications cause an explicit error and preserve the
original bytes in recovery files instead of overwriting another writer. No
generated baseline copies or package hooks are committed.

## Reproduction

Builds use the repository's pinned Rust toolchain, the cached test dependency
profile, and `opt-level=3` for the two leaf crates. This avoids rebuilding the
entire dependency graph in release mode. Debug assertions and overflow checks remain enabled. Dependencies remain in their
existing test profile, normally unoptimized. Cryptographic and database dependency costs
therefore need not match production release builds; the old/new comparison uses
the same dependency code.

Run from the repository root, after installing the existing Cargo dependencies:

```sh
CARGO_TARGET_DIR=/Users/pbio/work/hm1/rust/main/target python3 docs/performance/hot-paths/rust/run.py build --output /tmp/hm1-hotpath-rust-bench
```

Wait for every concurrent compilation to finish before timing:

```sh
python3 docs/performance/hot-paths/rust/run.py measure --output /tmp/hm1-hotpath-rust-bench --warmup 5 --repetitions 30
```

The measurement command never invokes Cargo. It invokes the compiled test
executables directly, one suite at a time, on a single-threaded Tokio runtime.
Each scenario runs five warmup pairs followed by 30 measured pairs. Pair order
alternates before/after, then after/before. Fixture generation, signing, and mock
database setup are outside each timed interval. Timer waits, RPC-result handling,
signature verification, and enrichment SQL construction are inside it.

## Workloads and metrics

| Case                 | Inputs and controlled delay                                                      | Work per timed batch       |
| -------------------- | -------------------------------------------------------------------------------- | -------------------------- |
| Multisig / zero      | Seven validators, all valid signatures, no RPC delay                             | One threshold-three quorum |
| Multisig / uniform   | Seven validators, all valid signatures, 5 ms per RPC                             | One threshold-three quorum |
| Multisig / straggler | Validator 0 waits 45 ms; others wait 5 ms; valid signatures at positions 1, 4, 5 | One threshold-three quorum |
| Scraper / zero       | 32 missing blocks or transactions, no RPC delay                                  | One enrichment batch       |
| Scraper / uniform    | Same 32 records, 5 ms per RPC                                                    | One enrichment batch       |
| Scraper / straggler  | Same 32 records; IDs divisible by eight wait 30 ms, others 5 ms                  | One enrichment batch       |

Tokio timers may round the configured delays; measured elapsed time is retained
without subtracting timer overhead. Scraper hash-map iteration order remains the
actual implementation's randomized order; the requested IDs and delay mapping
are identical for both versions. SeaORM's mock backend supplies identical query
responses, so PostgreSQL execution, network latency, and connection-pool
contention are excluded. Multisig signatures are real existing test-fixture
signatures and are verified by the actual method.

Both source versions link against the same current workspace dependencies; the
Cargo.lock digest is retained in the manifest. This isolates these method changes
from dependency or toolchain changes between independent full-commit builds.

The uniform and zero-delay cases are controls: rolling quorum reads can issue
additional speculative requests before reaching quorum, and concurrency can add
overhead when there is no I/O wait to overlap. Request counts are reported rather
than assuming fewer RPCs. Scraper reads should retain exactly 32 requests per
batch. Peak concurrency and zero active requests after each completed batch are
checked during the experiment.

`*.samples.jsonl` contains every raw sample, including marked warmups.
`summary.json` excludes warmups. P50 is the sample median; p95 uses nearest rank
(`ceil(n * 0.95)`). Items/second is batch-normalized completed items divided by
the sum of batch durations; it is not a sustained service-load measurement.
`*.process-time.txt` records aggregate process CPU and maximum RSS with the OS
`time` utility. Those envelopes include both versions, warmups, fixture setup,
and test-runtime overhead, so they are not presented as per-version CPU or memory
improvements.

Measured results are recorded in [results/table.md](results/table.md), with the
complete numeric summaries in [results/summary.json](results/summary.json).

## Recorded observations

The 32-record uniform-delay block and transaction batches improved from
234.246 to 30.297 ms and 235.855 to 30.920 ms at p50 (7.73x and 7.63x). Their
straggler cases improved 5.47x and 5.66x. Requests stayed at 32 per batch in every
sample; observed peak concurrency increased from one to eight under I/O delay.
Uniform batch-normalized throughput was 136.70 to 1057.32 blocks/s and 135.74 to
1047.24 transactions/s.

The multisig straggler workload improved from 61.390 to 23.820 ms at p50
(2.58x), with seven requests and peak concurrency four in both implementations.
Uniform latency stayed similar (14.470 to 14.308 ms), using four requests in both.
Zero-delay quorum latency also stayed similar (3.384 to 3.397 ms).

Zero-delay scraper medians became slower: blocks 0.090 to 0.094 ms, transactions
0.349 to 0.396 ms. Those controls are retained alongside the I/O improvements.
The complete p95 values and all raw observations are included, without filtering
out slow samples. There are 30 measured samples per version per scenario,
plus five warmups: 630 raw samples overall, 540 of them measured.

OS process envelopes covered both versions together. Multisig used 1.46 s user
CPU, 0.16 s system CPU, and 21,659,648 bytes maximum RSS over 6.86 s wall time.
Scraper used 0.84 s user CPU, 0.57 s system CPU, and 19,906,560 bytes maximum RSS
over 48.72 s wall time. These are experiment resource envelopes, not evidence of
a per-version CPU or memory improvement.

To export portable evidence after reproducing the measurements:

```sh
python3 docs/performance/hot-paths/rust/run.py export --output /tmp/hm1-hotpath-rust-bench
```

The exporter writes only the summaries, raw samples, process envelopes, and a
curated manifest under `results/`. Compiler logs, binaries, and machine-local
executable paths stay in the temporary output directory. Published SHA-256
digests use standard Base64 with explicit `*_sha256_base64` keys.

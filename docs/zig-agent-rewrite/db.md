# Native persistence and compatibility

The Zig code reuses **RocksDB 10.4.2** and **libpq 16.3**. It does not implement a
new storage engine. Native modules are optional; the default Zig test suite
checks codecs without linking a database client or opening a connection.

## RocksDB

`zig/src/db/codec.zig` preserves production `hyperlane-core` Encode/Decode:

| Value                                | Stored format                                                            |
| ------------------------------------ | ------------------------------------------------------------------------ |
| u32/u64                              | 4/8 bytes, big-endian                                                    |
| U256                                 | 32 bytes, **little-endian**                                              |
| bool                                 | Exactly byte 0 or 1; other first bytes rejected                          |
| H160/H256/H512, UUID                 | Raw 20/32/64/16 bytes; UUID RFC byte order                               |
| Fixed-record Vec                     | u64 big-endian count followed by items                                   |
| GasPaymentKey                        | message ID32 + destination u32 BE                                        |
| GasPaymentMeta                       | transaction hash64 + log index u64 BE                                    |
| GasPaymentData/ExpenditureData       | Two U256 LE values                                                       |
| InterchainGasPayment                 | ID32 + destination4 + payment32LE + gas32LE                              |
| Merkle insertion                     | leaf index u32 BE + message ID32                                         |
| Backward cursor                      | sequence u32 BE + block u32 BE                                           |
| Indexed fixed record                 | Inner encoding, bool sequence-present, optional u32 BE                   |
| Message                              | Existing canonical 77-byte prefix plus body, via protocol implementation |
| Pending operation status/retry state | Existing serde JSON enum tags/field order/version 1                      |

Fixed binary decoders deliberately retain Rust's trailing-byte acceptance. JSON
parsers reject unsupported variants, inconsistent retry deadlines, and unknown
retry-state versions. Vector decoding checks available bytes before allocation.
Returned message bodies may borrow the supplied encoded buffer; retain its owner.

`keys.zig` lists all 25 current HyperlaneRocksDB table prefixes. Full keys are
**domain name + `_` + exact table prefix + encoded key**, not a numerical domain.
Pending-destination keys append BE destination then BE nonce. Singleton highest
nonce and migration-marker tables use false's byte 0 as key. Domain names are
not case-normalized or substituted by this layer.

`rocks.zig` wraps the native C API with:

- Owned native handles, matching C destruction/free functions, copied errors.
- Copied get/iterator results with explicit caller lifetimes and NULL/empty separation.
- Atomic write batches, optional WAL fsync, prefix iteration/range deletion.
- Read-only opening, domain-scoped operations, native sequence numbers.
- Existing information-log limits and optional seven-day/1 GiB rollback-WAL retention.

Default sync=false matches Rust writes; durable users explicitly choose true.
Destroy iterators/batches before their borrowed database; these owners must not
be copied. Diagnostic pointers/domain names also borrow caller storage. An
uncertain native write outcome remains an error; resolving it belongs to the
operation's persistence state machine.

The linked engine is the actual `librocksdb-sys 0.17.3+10.4.2` archive built by
Rust. Compression archives are the same native build outputs. Rust's bzip2-sys
C build needs a `bz_internal_error` callback; `bzip2_glue.zig` provides the same
fatal-invariant behavior as its Rust callback. No compression logic is rewritten.
The C API exports no version probe; library provenance is recorded using source
lockfile, archive paths and SHA-256 identities.

Verification:

- **93 production Rust codec fixtures**: real core Encode/Decode and directly
  imported base storage-type source; all pass in Zig, plus truncation checks.
- **5 native tests**: atomic batch, fsync/reopen, empty values, domain isolation,
  ordered copied prefix results, prefix deletion, read-only failures, C error lifetimes.
- **Actual Rust→Zig→Rust database roundtrip**: production HyperlaneRocksDB writes
  12 rows; Zig compares every row, commits one WAL-synced batch updating gas/retry/
  cursor/processed state and pending index; production Rust typed reads verify it.

Artifacts: `zig/bench/results/rocksdb-interop.json`, public fixture manifest,
`native-db-tests.log`, `native-db-test-command.json`. Scratch databases were removed.
The native command artifact lists all seven standalone archive paths, including the runtime ABI guard. The build also supports
`native-db-test -Dnative-db-libs=<comma-separated-full-archive-paths>`.

## PostgreSQL scraper persistence

`postgres.zig` uses nonblocking libpq connect/query state machines with absolute
monotonic deadlines and cancellation. It binds text/binary/NULL values, checks
result indices, owns PGresult objects and copies diagnostics. Timeout/cancel or
transport failure after submission poisons/closes the connection because write
outcome can be unknown. Lost COMMIT acknowledgement returns
`CommitOutcomeUnknown`; callers must reconcile durable identity before retrying.
SQL errors are drained; failed rollback and unsupported COPY poison the client.

The optional vetted native libcurl resolver bounds hostname discovery and keeps
original libpq host/TLS identity alongside numeric hostaddr. An unresolved DNS
name adds a plain TCP preconnect with no application bytes; include that extra
connection in load measurements. Numeric hosts/hostaddrs and Unix sockets avoid
it. Unresolved multi-host DNS is explicitly rejected; `allow_blocking_dns=true`
is an unbounded compatibility opt-in. See `zig/src/db/postgres.md` for operation
and job deadlines, ownership, cancellation and DNS details. No configuration,
connection strings, parameter values or production credentials are logged.

`scraper_store.zig` ports the SQL contracts in the production near-head Store and
batch module against the **existing schema**:

- Initialization checks empty history and locks via positive-u32 advisory key;
  database domain columns preserve Rust's u32→i32 bit representation.
- Writer claim/expiry uses database clock; locked updates require the same writer
  and expected indexed hash. Runtime must supply a process-unique writer ID.
- All four event streams and sparse headers/checkpoints stage transactionally.
  Six-table insertion order and 1,000-row batches match Rust. Address/hash byte
  compaction, nullable transaction hashes, numeric gas values and sequence fields
  follow the source mapping.
- Reorg rollback removes only the provisional suffix. Confirmed-history crossing,
  changed observations, halted state and foreign-key conflicts fail closed.
- Confirmation prepares cursor assignment and checkpoint pruning, then rechecks
  locked progress/freshness before moving the frontier. Existing confirmed views
  and notification functions supply publication semantics; no replacement tables.
- Publication budgets preserve a single oversized block atomically and bound a
  split-block confirmation window by event count.

Reproduce using a **new disposable container**, production migrations and native
Zig tests:

```sh
python3 zig/integration/postgres.py \
  --compiler /path/to/zig \
  --sdk-root /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk
```

The runner requires a local `postgres:16` image, publishes a random loopback port,
builds/uses production `init-db`, and removes the owned container in `finally`.
It never uses an existing database or libpq's connection defaults. On Linux,
supply the native libpq library path and omit the macOS SDK argument. The
optional build step is `native-pg-test -Dlibpq-library=/path/to/libpq` and requires
`ZIGGY_PG_FIXTURE` supplied by the isolated runner.

Initial native integration passed PostgreSQL 16.15 with **21 actual Rust migrations**
and ReleaseSafe. Tests cover bound values/NULLs, aborted transaction rollback,
four streams and views, cursor publication, failed append atomicity, reorg suffix,
confirmed-boundary protection, stale confirmation rollback, writer takeover,
advisory locks, oversized block batching and unsigned domain storage. Final
results/source identities are in `postgres-integration.{json,log}`.

## Remaining cutover work

These are compatibility components, not a complete agent storage replacement.
The relayer's higher-level gas aggregation/sequence-conflict logic, derived-index
migration and cancellation, archived-WAL cleanup policy, unmarked-write WAL
recovery, terminal-message orchestration and full restart/crash schedule still
need runtime integration and parity proof. The PostgreSQL port does not replace
the scraper's RPC source, reconciliation/enrichment workers, subscriptions,
pool/reconnect behavior, metrics or complete daemon lifecycle. Its current tests
assert native state on production migrations; they are not a differential replay
of the private Rust Store runtime or a whole-agent benchmark.

No production database, schema, deployment, or live agent was modified.

The adapter now drives nonblocking libpq connect and query state machines with
absolute deadlines, bounded socket polling, cancellation and poisoned-connection
handling. An unknown write/commit outcome is retained explicitly. Optional
libcurl asynchronous DNS supplies numeric host addresses while preserving the
original hostname/TLS authority. Actual PostgreSQL stall/cancellation evidence is
archived under `zig/bench/results/postgres-bounded/`; constructor DNS behavior and
resolver limits are documented in `zig/src/db/postgres.md`.

The isolated integration runner also supports `--process-only --scraper-binary
PATH`. It still creates a fresh loopback-only Docker DB and applies actual
production migrations, then runs5 explicit server-side SQL smoke checks and the
actual process helper. It records `native_tests.executed=false` and does not
claim the skipped native suite or its11 functional cases. This avoids recompiling
unrelated native tests for process-only reruns; full-run failures retain their
log and `postgres-native-tests.json` status before the runner exits.

# Scraper

Zig port of `rust/main/agents/scraper/src/near_head`, receipt enrichment,
raw-message reconciliation, and same-chain CCR. It uses the native PostgreSQL
store and the existing production schema, rather than the test-only in-memory
scraper state machine in `runtime/scraper.zig`.

## Service integration

`service.Evm.init(allocator, rpc_client, connection, chain, writer_id,
db_timeout_ms) !*Evm` returns a heap-stable object. It borrows the serial RPC
client, serial PostgreSQL connection, and writer-id bytes; they must outlive it.
The caller joins all jobs before `deinit()`. Initialization checks the configured
chain identity, capabilities and saved contracts/checkpoints before cutover.
A native libcurl transport is required for concrete operation, so DNS/connect/
request deadlines and cancellation are enforceable. An invalid index period,
chunk or interval fails before cutover.

Submit one `headCycle() !runtime.Outcome` job per chain. The caller applies
`worker.delayAfter(result, monotonic_ms)` and treats its `critical` result
as a chain worker failure. A cycle observes the head, detects retained-history
forks, ingests a bounded range, proves continuity/completeness, confirms and
publishes. It returns `more`, `ingestion_failed`, optional ingestion error,
indexed/confirmed heights, and per-stream publication counts. Stale RPC heads
pause progression. Unavailable historical counts retain an unproven suffix;
a restart rechecks it. A fork crossing confirmed history halts durably.

The supervisor owns timers, cancellation, metrics, connection pooling and job
limits. Never concurrently use one RPC client or PostgreSQL connection. Head
work, delivery receipts, gas receipts, reconciliation and CCR have independent
progress; a failed auxiliary fetch must not block a healthy chain's ingestion.

## Receipt jobs

For each `enrichment.Lane{ .stream = .delivery/.gas }`:

1. `lane.plan(allocator, auxiliary_store)` snapshots at most 100 pending rows and
   returns an owned page with deduplicated transaction requests.
2. For each request, submit `enrichment.fetchAndPersist(allocator, store,
receipts_evm.Evm.interface(), request, absolute_monotonic_deadline_ns)` on
   separately owned RPC/DB clients. Persist successes independently. The native
   receipt fetcher binds transaction, receipt and retained block identities and
   shares the absolute deadline across its calls.
3. Once every request has completed or been cancelled/joined, call
   `lane.finish(store, page)` even when some requests failed. It links all
   cached/successful neighbors and returns `more`, `pending` and `linked`.
4. Destroy the page only after its jobs finish. A full successful page schedules
   another immediately; an incomplete sweep resumes on the next poll.

Use global RPC concurrency 16, per-domain RPC concurrency 4, DB concurrency 5,
and 30-second receipt-job budgets, matching the Rust source. Limits are
supervisor responsibilities; the APIs expose independent bounded jobs so slow
providers do not monopolize a single serial page task. The production pool applies immutable `session_timeout_ms` statement/lock defaults
once on each new or recovered connection, while its lease is exclusive. Every
lease still binds its own absolute client deadline and cancellation token.
Standalone pools without configured session defaults use
`storage.Store.configure(db_timeout_ms)` before borrowing the connection for work.

## Raw dispatch reconciliation

`reconciliation.Schedule` takes injected monotonic milliseconds. It prioritizes
near-head discovery over completeness sweeps, tracks immutable scan frontiers,
uses 100-row pages, 2-second page/global delays, 5-second discovery polls,
30-minute sweeps and lane-specific failure cooldowns. Initialize its discovery
watermark from the saved raw frontier; the completeness sweep covers old rows.
`Backoff` tracks at most 1,000 poison rows with 60-to-900-second exponential
retry delays, using UTC seconds for retry ages.

The supervisor calls `Schedule.due`, snapshots `store.rawFrontier` for a new
scan, then uses `planPage` or `planRetry`. Fetch `Plan.requests` independently as
for receipts. `finish(store, mailbox, &plan, &backoff, completion_utc_seconds)`
stores every resolved neighbor, preserves known transaction links on replay,
and adds only unresolved rows to backoff. Complete the corresponding scan
only after finish succeeds. On errors call `Schedule.failed`. Never advance a
scan using merely a successful transaction fetch.

## Same-chain CCR

`ccr.Evm.plan` gets the configured router logs in one filter and returns owned
candidates plus unique transaction identities. Independent `receipt` jobs bind
full receipt metadata. `assemble` selects the last preceding Transfer into a
configured source router from its configured collateral token. It rejects a
wrong receipt identity and excludes the destination router. Synthetic IDs
match the shared TypeScript `SameChainCCR` fixture.

`ccr.Lane.next(confirmed, finalized)` bounds the separate stream by both
frontiers and its configured chunk. Enrich **all** selected transactions before
`Lane.commit`; native `storeCcr` preflights the entire batch and stores message/
delivery pairs atomically. Replay repairs a missing delivery and preserves the
synthetic identity. The lane cursor advances only after all persistence succeeds.
The supervisor can parallelize at most 20 independent CCR receipts, matching
Rust, without sharing mutable RPC clients.

## Source coverage and boundaries

`evm.Evm.interface()` is concrete: one combined four-event/three-contract log
filter, exact topic/address/metadata checks, canonical range rechecks, and
actual EIP-1898 `{blockHash: ...}` historical mailbox nonce/Merkle count calls.

`generic.Adapter` implements complete sequence-page coverage, per-cycle tips/
header caching, count-based finality protection, bounded sparse-slot searches,
and Sealevel insertion derivation. Its protocol indexers are injected callbacks.
`setup.prepare` preserves empty-only sequence/Radix cutover, Cosmos height-one
minimums, relative starting heights and capability validation. Concrete factories now bind all eight VM types through `factory.zig` and
`agents/chain_source.zig`. Native read/index primitives are exercised separately
from operational process evidence; construction alone is not a live rollout.

## Verification

`testing.zig` provides deterministic fault/restart tests for incomplete logs,
pruned count history, lagging RPCs, changing ranges, confirmed forks, receipt
poison rows, retries, complete sequence pages and sparse slots. `rpc_testing.zig`
uses actual loopback HTTP to assert filters, hash-pinned calls, deadline sharing,
receipt identity and collateral matching. Default tests do not load libcurl or
libpq. `native_test.zig` is imported only by `src/pg_tests.zig` and runs against
the guarded migrated disposable fixture:

```sh
python3 zig/integration/postgres.py \
  --compiler /tmp/ziggy-toolchain/zig-aarch64-macos-0.15.2/zig \
  --sdk-root /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk \
  --output /tmp/ziggy-scraper-pg-results
```

No test reads a production credential or endpoint, signs a production
transaction, or writes a production database.

## Operational task set and shared client ownership

`task.TaskSet.open(a,*Settings,*EnvMap,Options{curl_library,metrics,...}) !*TaskSet`
constructs local scheduling/PG-pool state. Network and chain binding initialize
on worker callbacks. `.descriptors()` supplies real supervisor tasks;
`.deinit()` follows supervisor cancellation and join. Settings/environment remain
borrowed. Defaults: head jobs120s, auxiliary30s, request20s, native DB operations30s;
configured DB connection/acquire limits are retained. Migrated production schema
and domain rows are prerequisites, exactly as for the Rust scraper.

Each chain has independent head, delivery, gas and reconciliation contexts;
configured EVM CCR adds a fifth. Each context owns its own chain resource/client
and cancellation token. Receipt/reconciliation planning uses a short PG lease,
then chain reads run with no DB lease, and each completed transaction persists
under its own short lease. Delivery/gas finish links durable successes despite
failed neighbors. Raw discovery/sweep snapshots and bounded retry state persist
across jobs, with the shared two-second page limit and independent lane backoff.
Unknown COMMIT is never replayed as SQL; the next head cycle clears cached counts
and rereads durable frontiers on a fresh connection. Reorg/critical-head failures
halt the supervisor rather than publishing across a confirmed conflict.

Receipt reads now retain each planned delivery/gas/reconciliation/CCR page and
its original absolute deadline across `PendingReadIo`. `receipt_jobs.Batch`
admits at most16 jobs globally and4 per domain across all lanes. Each admitted
job owns a read fork with independent request IDs/journals, borrows its lane's
RPC pool and the TaskSet's one shared HTTP runtime, and releases admission only
after its result is persisted or rejected. No per-request threads/pools are
created. PG leases are bounded to at most5 and held only for DB operations.
Successful delivery/gas neighbors link immediately while a sibling remains
pending; unknown transaction outcomes are reconciled by durable keys on retry.

Native fanout evidence uses four actual Resource parents,16 receipt jobs,
eight stalled jobs and eight successful transaction/receipt decodes; each
healthy domain sends exactly12 physical RPCs (four chain-ID, four transaction,
four receipt). Fault and allocation tests cover failed-neighbor isolation,
deadline retirement and zero leaked admission/quota. This proves receipt read
fanout. Mutating head publication runs intact on one lazy retained owner per
configured head lane, with a1MiB explicit stack and stable cancellation token;
the Supervisor only submits/polls. Teardown cancels every head owner before
joining any, then retires receipt forks and releases clients/runtime/DB.
The real process fixture configures nine chains, stalls the first eight head
identity RPCs, and verifies fresh production-contract indexing on the ninth
through eight Supervisor workers. It records RSS and configured head stacks;
these additional threads/stacks are part of the runtime cost and do not imply
Tokio-equivalent thread or memory use.

`agents/chain_source.Resources.open(a,*Chain,*EnvMap,Options)!*Resources`
owns normalized endpoints/headers, optional native crypto and concrete client
bindings. `.source()!Source`, `.receipts()!Fetcher`, `.setCancellation(token)` and
`.deinit()` share one serial resource owner. Independent validator voting slots
use `rpc_urls`, `grpc_urls`, or `wallet_solidity_urls` overrides according to the
actual chain's state authority; `direct_native_transport=true` skips an unused
RPC owner thread. `setReadOnlyOverride` is exclusively for bounded asynchronous
read-vote replay; it never belongs to signing, broadcast or public CCIP jobs.
Ordinary EVM/SVM/Cosmos JSON-RPC uses the native async endpoint pool. Its memory
quota derives from all configured peers and current/retiring rounds, with
explicit response/byte-budget overrides. Radix Core/Gateway reads retain ordered
endpoint fallback; notarized submissions use one exact endpoint.

Cosmos gRPC uses source fallback priority snapshots across forks: at least four
total errors,100ms between retry rounds,10-failure reprioritization, and one
serialized latest-validator-set height probe after120s. One endpoint never
adds a health probe. Query/probe share a30s provider ceiling; the retained job's
absolute deadline can end earlier. Cooperative typed futures own isolated HTTP
journals, so identical before/after queries stay distinct while completed
prefixes and health updates are reused once. Protobuf memo/snapshot ownership
is charged to the shared read quota and retired on commit/cancellation. Source
SVM/Tendermint JSON-RPC aging probes use their native height methods.

Read-only metadata uses `Resources.forkRead(a)!*Resources`: independent typed
client IDs, headers, replay journals and immutable metadata metrics attribution;
the parent's RPC pool and global HTTP runtime are borrowed. No pool/I/O thread
is created per fork, and signer fields/environment credentials are excluded
(only explicit Aleo native-library/worker paths are copied). Parent settings,
shared runtime and byte quota must outlive every fork. Bracket each retained
pass with `beginReadPass`/`endReadPass`; commit only after advancing its pure
read controller. Fork destruction cancels and retires its owned handles.

`rpc_parallelism` defaults2 for origin lanes and accepts up to128 total RPC
sessions, including cancelled transfers awaiting retirement. Metadata callers
can configure128 with bounded32KiB ordinary EVM responses; CCIP may explicitly
raise its scoped response cap. The pending/physical limits derive from every
configured peer; impossible fanout above4096 pending transfers is rejected
without changing a quorum denominator. The shared read quota covers cached
responses and source frames; native wire reservations remain per RPC pool.

Receipt adapters: `receipts_evm`, `receipts_sealevel`, `receipts_cosmos`,
`receipts_radix`, `receipts_tron`, `receipts_starknet`, `receipts_aleo`.
`receipt_factory.Factory.init(a,Clients,*Chain,Options{})!*Factory` binds all eight
without a signer. Production requires bounded native transport; fixtures alone
may opt into standard HTTP. EVM/Tron retain tx/block binding; SVM requests parsed
finalized transactions and source recipient heuristics; Cosmos parses TxRaw,
fee payer and denomination policy; Radix parses fee-lock manifests against SDK
fixtures and retains source cumulative-gas assignment. Starknet/Aleo reuse their
actual SDK/native transaction semantics. All fetches share absolute budgets.
Aleo needs explicit `HYPERLANE_ALEO_CRYPTO_LIBRARY`, `HYPERLANE_ALEO_VM_LIBRARY`,
`HYPERLANE_ALEO_VM_WORKER`; no proving parameter home or private key is needed
for these read/index/enrichment paths.

The optional `zig/integration/postgres.py --scraper-binary <daemon>` hook runs
`scraper_process.py`: real production Solidity on disposable Anvil, migrated PG,
receipt stalls versus independent head progress, persisted enrichment, joined
SIGTERM/SIGINT and durable restart. It never uses production endpoints or keys.

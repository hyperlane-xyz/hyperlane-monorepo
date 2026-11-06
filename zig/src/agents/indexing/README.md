# Concrete source and native origin integration

This is the common binding point for relayer/validator/scraper services. It uses
actual chain wire clients and the existing production RocksDB or PostgreSQL
storage contract. Endpoint providers, credentials and job scheduling are injected;
no production key or endpoint is read by construction.

## Create one stable source

`agents/scraper/factory.Factory.init(allocator, Clients, *const settings.Chain)
!*Factory` owns its binding object and the Sealevel adapter/cache. It borrows all
clients and settings-dependent transport resources. Call `.interface() !Source`
only at the object's final address, then keep it stable until all jobs are joined.
Destroy the binding with `.deinit()` before releasing borrowed clients.

`Clients` variants:

| Variant  | Borrowed client                                                            | Concrete source behavior                                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ethereum | `*evm.provider.RpcClient`                                                  | Combined exact log filter; EIP-1898 pinned counts; chain-ID check; native HTTP required                                                                                                      |
| sealevel | `*sealevel.provider.Client`                                                | Finalized sequence PDA lookups, owner/PDA/domain verification, static/ALT/inner-instruction transaction matching, derived tree insertions                                                    |
| cosmos   | `{tendermint: cosmos.tendermint.Client, queries: cosmos.contracts.Client}` | Both Cosmos/CosmosNative via typed chain.protocol; actual block/results, transaction SHA256, ABCI events and historical gRPC query heights                                                   |
| radix    | `radix.provider.Client`                                                    | Core count previews, Gateway bounded transaction pagination, receipt/SBOR events and source state-version identities                                                                         |
| tron     | `*tron.provider.Provider`                                                  | walletsolidity canonical headers, exact EVM log codec, count-before-tip solidified state                                                                                                     |
| starknet | `*scraper.starknet.Factory`                                                | Caller creates `Factory.init(a,http.Transport,*Chain)`; canonical receipt/event positions and pinned counters                                                                                |
| aleo     | `*scraper.aleo.Factory`                                                    | Caller creates `Factory.init(a,http.Transport,*crypto.Crypto,*Chain,Native)` with an explicit isolated consensus decoder worker/library; real mapping tips and accepted-block reconciliation |

Use the original chain constructors to build the borrowed clients, preserving
configured RPC/grpc/Core/Gateway/wallet endpoints and headers. A Cosmos gRPC
transport must implement authenticated HTTP/2 and checked trailers; the tested
`cosmos.curl_grpc.CurlTransport` does so. Never substitute a REST gateway for
configured grpcUrls. Native Sealevel and Cosmos modes are selected explicitly;
unsupported sequence configurations fail instead of fabricating a block index.

## Relayer origin

`agents/indexing/service.Service.open(a, *Chain, Source, *rocks.Database,
?*remote_checkpoints.Engine, gas_enabled) !*Service` is heap-stable and exposes:

- `.store`: existing `agents/store.Store` operations and Rust DB key contract.
- `.history`: existing `agents/origin.Origin` proof/remote-quorum interface.
- `.tick(monotonic_ms, cancel) !Report`: one bounded, fairly rotated stream range.
- `.deinit()`: after all jobs using the source/store/history have joined.

EVM uses the parent-owned `agents/evm_origin.zig` driver. The generic driver
handles other actual sources. Counts choose sequence cursors for dispatch/tree
and indexed gas; unsequenced gas retains its separate conservative forward
watermark and poll cadence. Block/sequence modes, relative starts, gap backfill,
per-stream due times and durable cursor updates reuse the Rust-compatible cursor
state machines. Range reads are canonically fenced before any event write.
Immutable, verified Sealevel PDA events may retain basic metadata when historical
blocks are pruned, matching the Rust fallback; the live finalized tip is rechecked.
Partial DB failure is replayable; cursors advance only after all selected writes.

Parent scheduling owns exactly one mutation job per chain, thread-safe allocator,
transport/DB deadlines and shutdown. The driver binds Source cancellation for
EVM/SVM/Cosmos; caller-owned native cloud HttpTransport cancellation must also
be bound for Radix/Tron/Starknet/Aleo. All clients are serial and cannot be shared
between concurrent jobs. Independent enrichment jobs require separate clients.

## Validator insertion-only mode

`indexing/source.Core(native.Store)` is the same cursor/persistence engine without
NativeOrigin prover overhead. Set `.options.enabled_streams = .{false,true,false}`.
At least one enabled lane is required. Rotation, sleep and next-delay calculations
consider only enabled lanes, including the gas_enabled option. Validator checkpoint
reads/signing remain in the validator service and use the concrete contract client.

Source stream numbering is dispatch0, delivery1, gas2, insertion3. `streamTip`
returns the actual count and reported height for just the selected stream;
`rawSequence` exposes authenticated sequence-account reads for Sealevel. The
scraper's existing `events(from_block,through_block,sequence_counts)` API still
returns complete block coverage and is not reinterpreted as a sequence range.

## Scraper native PostgreSQL service

`agents/scraper/service.Native.init(a,*pg.Connection,Source,*Chain,writer_id,
db_timeout_ms)!*Native` binds the same concrete source to near-head confirmation
and publication. Call `.headCycle()` and use its worker's `.delayAfter(...)`.
`auxiliaryStore(connection,mailbox)` supplies independent receipt/reconciliation
storage. See `agents/scraper/README.md` for plan/fetch/finish jobs and CCR.
Set/reset `connection.io` per whole job; `db/postgres.md` describes absolute
native deadlines, bounded DNS and unknown-COMMIT reconciliation.

## Evidence and remaining work

Pure origin tests cover both index modes, three-lane fairness, disabled gas,
canonical changes/cancellation before writes, omitted sequences, partial DB
failure/replay, conservative gas watermarks and insertion-only validator polling.
The actual production RocksDB fixture writes all streams, verifies messages and
gas, builds historical proofs, reopens the DB and resumes without duplicate data.
SVM transaction matching consumes nine exact production Rust JSON fixtures,
including ALTs, inner instructions, reverted siblings and transaction index33.

Concrete read/index and receipt bindings are implemented. Shared
`agents/chain_source.Resources` owns clients for all eight VM types;
`scraper.task.TaskSet` binds operational supervisor lanes and native PG pooling.
See the scraper README for exact APIs and process evidence. Construction alone
does not establish live-chain rollout.

## Cooperative source continuations

A concrete `Source.read_section` opts Core into retained stages. Resources installs
that hook only for explicit `cooperative_reads`. Core freezes its selected stream,
clock, tip and cursor token across PendingReadIo. It retains a range-level
canonical before/after fence and owned, quota-bound block results; prior completed
blocks/native decoders do not rerun when the next block suspends. Each current
block/sequence retains its full canonical event checks. Real failures abort the
frame and fail the pending cursor; no staged range is published after a fork.

`cooperative_max_range` bounds one durable cursor query: service defaults32
positions, Aleo2. Configured index.chunk remains an upper bound. Sequence cursor
slicing keeps a forward prefix/backward suffix and updates its exact pending
range/token. Unsequenced gas retains the original admitted query end across
pieces, bypassing near-head sleep only until that admitted range completes.
Its configured chunk still controls conservative persisted watermarks. This
changes query distribution/number of range fences versus one large Rust range;
configured polling intervals and cursor completeness guarantees remain intact.
The bounded jobs avoid a multi-thousand-block callback exceeding its retained
120s attempt budget with20ms scheduler wakeups. Measure throughput/freshness
before production use rather than inferring a VM-wide speedup.

Pure fetch progress precedes the replay commit hook. Durable event/cursor writes
complete before advancing to the gas tip-refresh stage. Thus a suspended refresh
cannot repeat earlier writes or reuse its former tip observation. Batch ownership
includes an optional quota lease, released by `Batch.deinit`; the shared caller-
owned quota must outlive retained batches. Noncooperative sources use the original
path.

Native proof: `src/indexing_native_tests.zig` includes sixteen actual pinned
Starknet SDK readers through shared native HTTP and eight scheduler workers;
eight endpoints stall while eight authenticate chain ID, decode canonical
insertion/receipt/block identity, persist RocksDB rows, construct historical
Merkle proofs and reopen the database. This is a Starknet integration fixture,
not evidence that sixteen independent live blockchains or all VM production
endpoints were tested. Separate Cosmos/Aleo source fixtures qualify their paths.

`cosmos_native_test.zig` drives the actual Cosmos Adapter/Core through native
JSON-RPC continuation reads and RocksDB over33 scripted CometBFT0.38 blocks.
Its32+1 gas cursor slices preserve configured chunk1999 and watermark1; every
block-results request occurs once, two distinct transaction payments aggregate
to5000 across reopen, and no near-head sleep interrupts the admitted range.
This is source-correct scripted wire, not a live Cosmos SDK node. Typed historical
gRPC framing/trailers are covered separately by the real HTTP/2 fixture.

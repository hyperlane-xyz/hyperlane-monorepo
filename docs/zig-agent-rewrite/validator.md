# Durable validator service

`zig/src/agents/validator.zig` implements the checkpoint service on native
RocksDB. `agents/validator/driver.zig` bounds replay/publication per tick;
`agents/validator/evm.zig` supplies a concrete EVM RPC/indexing/announcement role.
The native executable/supervisor wiring is maintained separately by the parent
integration. These components do not establish complete multi-VM daemon parity.

A versioned domain namespace pins domain, hook and signer. Every finalized
observation atomically stores its root, block provenance, frontier, Borsh snapshot
and unpublished index. Signing reservations, verified signatures, publication
completion and fatal guards use atomic WriteBatch with WAL enabled and per-write
fsync. Reservations survive restart; the exact checkpoint is revalidated before
signing. Durable signatures resume publication without signing again. New
signatures require fresh matching RPC authorization after every restart/round.

One slot remains per configured endpoint, including unavailable responses.
Canonical URL identities remove duplicates. Authorization selects the required-th
highest locally matching checkpoint, preserving mixed-height authentication.
Quorum requires ceil(N/2), majority ceil(2N/3), matching production Rust. Native
EVM polling starts every slot concurrently on one libcurl multi owner, progressing
chain-ID, finalized head, count, checkpoint and a block-hash fence. The configured
absolute endpoint deadline covers the entire sequence. Early cancellation is
allowed only when outstanding/higher votes cannot advance the selected quorum;
a stalled minority does not block a complete healthy quorum. No per-request
threads or shortened endpoint timeouts are used.

Before signing, the service reads the backend reorg guard and existing checkpoint
object. Conflicting signed history persists a fatal local/backend guard before
another signer call. The concrete EVM role audits trusted prefixes even when RPC
counts grow: it locates the canonical block for the trusted index, obtains the
prior frontier and replays canonical events within that block. This also handles
multiple insertions in one block and snapshot anchors without block provenance.
An unsigned/unverified suffix can be atomically discarded and replayed from a
healthy reader; committed signatures and verified prefixes are retained.

Publication writes the highest eligible checkpoint and monotonic latest pointer
first, then fills every older index. A snapshot is published only after all its
covered checkpoint objects are durable. Each failed step leaves the reservation
and signature available for idempotent retry. Authenticated remote snapshot
bootstrap pins signer/domain/hook/root and restores the frontier; it does not
assume historical objects exist. A separate durable repair cursor replays and
validates old objects against the anchor before missing objects can be signed
under fresh authorization. The default driver bounds observations/history repair
at 64/32 and publications at 32 per tick. Observation/history bounds are ≤64;
publication concurrency accepts the source setting up to1,000 (default50 in
the configured executable).

`agents/signer.zig` owns secp256k1 identities independently of checkpoint signing.
It supports local hex keys, AWS KMS and GCP KMS. AWS aliases resolve to a canonical
ARN once; later signatures remain pinned to that ARN and public key. Refresh
changes caller-owned credential leases, transport and SigV4 date without rotating
the identity. `agents/validator/config.zig` combines this signer with actual
LocalStore, S3 or GCS publication. No factory implicitly reads credentials.
Constructors/signing execute inside a bounded worker; settings, credential leases,
DB and transport must remain live through each operation. Drain jobs before
deinitializing resources, signers or transports.

The EVM role writes a signed offchain announcement, checks actual announced
locations and queues missing onchain announcements via an injected durable lander
owner. The native integration uses disposable Anvil, real Mailbox/MerkleTreeHook/
ValidatorAnnounce contracts, public test keys, native RocksDB, actual HTTP and
production Rust codec/Merkle reference outputs. It covers a hanging first RPC,
announcement gating, classic fallback with a stalled redundant peer, three
signed checkpoints, restart without new signatures,
remote snapshot bootstrap/history repair and a growing-count signed-prefix fork
followed by durable restart rejection. Artifacts:
`zig/bench/results/validator-evm-integration.json` and
`zig/bench/results/validator-native-tests.log`.

Complete per-VM executable acceptance remains outstanding; shared WebSocket and
lightweight Role wiring now has the EVM process acceptance recorded below. Every
index stores a 1,032-byte Borsh frontier, a deliberate
space cost for historical access. Local fault/integration evidence does not prove
sustained mainnet tracking, deployment readiness or whole-agent speedup. Cloud
identity/object behavior has mock coverage; no live cloud credentials or remote
production state were used.

The shared non-EVM `validator/generic.zig` now binds actual typed chain clients,
concurrent checkpoint reads, insertion-only native indexing, durable validator
state, checkpoint signer and checkpoint publisher. State endpoint identity comes
from each protocol's actual read transport (Cosmos gRPC, Tron walletSolidity,
Radix Core), with canonical URL deduplication and a fixed vote denominator.
The read replay cache is scoped to one bounded round and only wraps read-only
HTTP/gRPC. Original JSON-RPC response IDs are validated before changing replay
IDs. Equal before/after fence requests retain distinct occurrence positions.
The native fixture starts27 Tron slots, physically stalls the first9, and obtains
18 healthy votes without per-request worker threads; three Starknet cases cover
correct replay, wrong original IDs and a changed second header fence.

`python3 zig/integration/generic_validator.py` passed native generic Role
indexing/signing/publication/restart/snapshot repair and a growing-count signed
prefix fork. The fixture bridges Tron HTTP calls to disposable local repository
Solidity contracts, so it validates the native Tron surface and shared Role,
not Tron consensus/execution or full all-VM daemon coverage. The fork replay
ignores native DB skip markers, processes at most64 leaves per tick, validates
its full replay root against the independently collected checkpoint quorum, then
compares the old signed prefix before choosing durable halt or unsigned reset.
A missing canonical replay prefix cannot authorize signing. The artifact is
`zig/bench/results/validator-generic-integration.json`.

The same native fixture now also corrupts insertion IDs at the first indexing
RPC, verifies the full audit root disagrees, rotates indexing RPC, repairs
canonical leaves, resets only the unsigned suffix and signs3 correct roots. A
second fork fixture gives read endpoints different canonical counts3 and4. The
bounded replay independently matches each endpoint frontier at its own count;
a fixed quorum of matches at/after the old watermark authenticates that common
prefix and triggers the durable conflict guard. No historical call is fabricated
for latest-only Tron. `frontier_audit.zig` has focused mixed-count, minority-root,
old-watermark and allocation-failure tests.

Native announcement actors are wired into the executable through a separately
scheduled worker. Remaining generic-role acceptance work includes actual per-VM
process fixtures. Lightweight and websocket modes remain explicit errors. The local
Tron bridge is not reported as all-VM operational parity.

Checkpoint verification/publication and self-announcement now have independent
supervisor descriptors and retained worker contexts. Each owns HTTP, native
clients and credential leases; the main thread only allocates/configures owners.
A shared lazy `DatabaseOwner` opens sync RocksDB inside a worker. Callbacks copy
at most2MiB of public request data into a single durable mailbox; they do not
mutate Lander or native transaction actors. Only a new request or a completed
state change wakes the announcement job. Duplicate pending callbacks retain the
first valid signature and respect configured retry intervals. A fresh missing
location after a completed announcement reopens a monotonic mailbox revision;
Lander IDs and private native actor journal namespaces distinguish that attempt.
The signed announcement digest and domain/mailbox/target authority stay intact.
Fatal checkpoint guards halt both descriptors and cancel/drain their jobs.

The actual two-descriptor Tron gateway fixture signs/persists/broadcasts native
protobuf, then physically stalls its receipt request with the configured20s
request deadline unchanged. Checkpoint publication still completes3 Rust-matching
objects in1.36s and8 successful worker cycles; shutdown drains in102ms. Those
numbers are correctness deadline evidence under a disposable fixture, not a
Rust-vs-Zig performance comparison. The isolated mailbox suite passes34 tests including the actual native RocksDB
capacity, signature retention, duplicate/no-wake and completed-goal reopening
fixture, protocol/codec checks and allocation failures. Constructor tests prove
no DB/client/library I/O and independent descriptor/HTTP ownership.

An expired native announcement requires protocol-specific positive retirement
evidence and canonical published-location absence before another transaction may
be prepared. The worker now consumes the native Factory retirement API; SVM has
positive expiry plus finalized location-absence checks. Other VM-specific expiry
proofs remain incomplete. Receipt absence alone never allocates another nonce or
signature. Complete per-VM executable fixtures remain outstanding; EVM WSS and
lightweight acceptance is recorded below.

The actual EVM executable also passes the split-worker fixture:
`zig/bench/results/validator-evm-split-integration.json`. While a real receipt
request remains stalled under the unchanged20s deadline, it publishes3 matching
checkpoint objects in2.44s, drains on SIGTERM, then restarts with identical
checkpoint bytes and unchanged transaction nonce. This is local correctness and
scheduling evidence, not a matched performance result.

Physical RPC telemetry records native completion once. Re-executed SDK reads and
cached responses do not increment counters. The27-slot Tron fanout records18
completed healthy requests while9 peers remain stalled; Starknet replay records
8 actual requests across its repeated read/fence sequence. Original JSON-RPC IDs
remain authenticated before cache replay. Metric labels contain bounded method,
chain and sanitized host labels, never URL credentials, paths or query strings.

Classic/null-consensus checkpoint polling now retains one healthy state reader.
EVM startup races only chain-ID readiness probes; generic startup uses the
protocol-authenticated frontier when that is the identity-bearing state. Later
normal rounds query one primary and rotate after an actual failed read. Explicit
majority/quorum keeps full fixed-denominator fanout. Native role fixtures retain3
Rust-matching roots and exercise real HTTP/RPC failures; the unchanged stalled
first endpoint, growing fork, mixed-count and snapshot cases remain green.

The source `maxSignConcurrency` setting now drives bounded concurrent signing
and publication through a lazy persistent native thread pool. Each active worker
has a256KiB stack; the pool grows only to an actual publication batch, up to the
configured limit (default50, maximum1,000). This uses native threads where Rust
uses async `join_all`, a resource tradeoff that final process timing must include.
Concurrent adapters require a thread-safe allocator, immutable native transport
and frozen credentials/cancellation state. Injected callbacks remain serial unless
they explicitly declare that contract. Refresh and teardown wait for every actual
callback to return.

Every per-index reservation and resulting signature is WAL-synced before external
publication. The highest eligible object alone advances the monotonic latest
pointer; lower objects can finish later. Covering snapshots wait for every older
object. Failed latest publication resumes the persisted signature after restart
without a new signer call. Local native tests physically hold a lower object while
a higher object/latest pointer completes, then test failed latest and restart.
The focused native suite has157 passes and16 optional skips; these are explicit
optional native/backend suites, not simulated successes.

`validator-parallel-http-integration.json` demonstrates4 simultaneous actual
native HTTP KMS requests for8 unique checkpoint digests. The disposable AWS
emulator verifies SigV4 and returns independent Rust k256 DER signatures/SPKI;
actual configured alias resolution pins the canonical ARN and public key. All8
roots/IDs match production Rust and reopening signs zero additional checkpoints.
No live AWS/GCP credentials were used. This is concurrency/correctness evidence,
not a throughput benchmark or all-cloud operational acceptance.

The validator exposes source-compatible `/ready`, EigenNode and inclusive Merkle
insertion inspection routes. Twenty-nine independent fixtures execute the actual
production Rust Axum module, including readiness blockers, health thresholds,
query errors, HEAD and the trailing-slash404. Native insertion responses enforce
an8MiB serialized-body budget before allocating rows; oversized results return413
without imposing an arbitrary index-range limit. Read handlers execute in bounded
HTTP jobs and drain before task/DB teardown.

`validator-http-parallel-process.json` tests the current RPC-mode executable on
real repository contracts: admin GET/HEAD/error routes and physical RPC metrics
pass;3 Rust-matching checkpoint objects appear in2.35s while the announcement
receipt remains stalled under its20s deadline. SIGTERM drains and restarting
changes neither checkpoint bytes nor transaction nonce. The daemon digest is
recorded independently of the older Role fixture binary. That pinned run predates WebSocket/lightweight wiring; later WSS acceptance
is recorded separately below. Final matched performance measurements remain pending.

An independent parallel-publication review found a guard retry gap after an
uncertain WAL/fsync error. The service now retains the complete reorg event before
allocation or I/O, sets the shared announcement/signing halt immediately, and
retries local sync writes plus readback and backend guard publication. A visible
uncertain write is retried with another fsync. `ReorgGuardPersistencePending`
keeps the retained owner retrying; the process reports pending guards after job
drain. Startup announcement jobs independently read the durable guard, closing
the race with checkpoint Role initialization. Native authorization/sign callbacks
and EVM transaction signing recheck the shared halt without replacing job cancel
or shutdown deadlines.

Actual RocksDB fault tests inject failure before commit, an ambiguous failure
after successful commit, and a backend guard write failure. Retry and reopen
preserve the halt and signer call count. Focused guard tests pass3/3; constructors
13/13; the current native suite159 passes/16 optional skips. Evidence and the
original independent report: `results/validator-guard-retry/`. A process cannot
guarantee a newly observed guard survives SIGKILL or permanent storage failure
before successful persistence; existing signed-history reauthentication remains
mandatory on restart. The earlier pinned RPC executable acceptance predates this
fix and is retained separately.

The native KMS retry fixtures additionally cover five transient failures per
checkpoint followed by the sixth same-ARN attempt (48 requests for8 digests),
and exhaustion of all six attempts for the first4 digests with no checkpoint
objects published. Reopening the same DB with fresh authorization then publishes
all8. SigV4, canonical key identity and every recovered signature are checked on
every actual request; peak native request concurrency remains4. Artifacts:
`validator-parallel-http-retry-last.json` and
`validator-parallel-http-exhausted.json`. This tests the explicit outer signing
retry budget; it does not establish production cloud failure/expiry parity.

Actual WSS executable acceptance is now recorded in
`zig/bench/results/validator-wss-process.json`, using the separately pinned CLI
and an explicitly trusted local fixture certificate. Lightweight mode publishes
three checkpoints with zero `eth_getLogs` requests. A schema rejection while the
physical socket remains open forces disconnect and a new generation. Restart
preserves checkpoint bytes and the announcement nonce. Normal mode backfills
through RPC, cuts over only after stream freshness validation, then publishes a
new streamed insertion without further RPC event indexing. Every root and message
ID matches the production Rust oracle.

Authenticated snapshot startup retains separate foreground and missing-history
cursors. When an old checkpoint object is missing, the same socket-owner thread
opens a second canonical replay connection from the first missing insertion.
Foreground checkpoints continue while that history connection is held; the
covering snapshot does not advance until authenticated repair finishes. The
retained transport owner uses one configured1MiB stack for both connections and
shares bounded event/command byte budgets. Controller/DB/signature mutations stay
on the checkpoint worker. This is a scraper-protocol fixture on actual Anvil
contracts, not a public scraper endpoint or all-VM stream soak.

`validator-guard-sigterm-process.json` closes the process-level uncertain-write
case. A fixture-only DYLD interposer, restricted to the exact disposable RocksDB
path and reorg WAL record, performs the real guard fsync and reports EIO. The
unchanged CLI retains its pending halt, signs/publishes no new checkpoint objects,
and SIGTERM exits1 with `ReorgGuardPersistencePending`. Restart without the
interposer finds the durable halt, publishes the backend reorg flag and exits1.
Three prior signed objects remain byte-identical. The unrelated-path negative
control passes; no production fault injection is linked into the agent.

The final stream cadence follows production `submit.rs`: socket notifications
cannot bypass the configured minimum between checkpoint reads, retained samples
waiting for insertions refresh after30s, and authenticated idle frontiers receive
a60s root audit. The idle gate additionally checks durable pending publication
and snapshot/history work, so a failed latest pointer or old history hole keeps
retrying without another stream event. Decisions inspect the next committed
prefix leaf, including an accumulated suffix from a faster minority.
`validator-wss-cadence-idle-audit.json` repeats WSS/cutover/reconnect/history
acceptance and physically forks the chain to a different root at the same count
without sending a new stream insertion. The idle audit detects it and durably
halts with exit1; prior signed objects are unchanged and RPC event indexing
remains zero. This is elapsed-deadline correctness evidence, not a performance
sample.

The retained failing artifact `validator-wss-initial-handshake-stall.json`
records a late retry bug: one HTTP503 before WebSocket upgrade produced a new
transport generation without a connected event; the consumer ignored that
terminal generation and never retried. The consumer now retires a newer terminal
generation monotonically before scheduling reconnect. Transport setup failures
that occur before a generation exists retain a bounded reconnect deadline.
`validator-wss-handshake-retry-process.json` verifies HTTP503, a later schema
rejection on an open connection, successful replay, unchanged restart, history
repair, normal cutover and the60s same-count-fork guard on the repaired binary.
`validator-guard-handshake-retry-process.json` repeats the uncertain-fsync
SIGTERM/restart case on that same binary. Original failed and earlier passing
artifacts remain separate.

Unknown header hashes from scraper events remain explicitly unavailable. They
cannot conflict with a later known RPC header solely because their bytes are
zero. The native same-block transition regression passes while conflicting
known headers retain their guard. Native validator coverage is164 passes and18
explicit optional skips. The native WebSocket suite has22 passes, including
teardown before zero/one of two expected connections and during a partial
handshake; teardown joins the worker before closing its listener and shuts down
active I/O without a descriptor-reuse race.

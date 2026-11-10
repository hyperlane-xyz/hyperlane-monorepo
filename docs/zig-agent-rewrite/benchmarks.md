# Rust → Zig benchmark contract

The retained measurements include protocol kernels, packed-prover and signing
kernels, intermediate whole-validator/scraper pairs, and diagnostic relayer runs.
They do not establish final-source whole-agent performance. Final balanced role
pairs and matched cold/no-change builds remain gated on source freeze and actual
process acceptance. All improvements, regressions and failed attempts will remain
in the results and draft PR. No10× LOC /7× build-time claim is assumed.

The Rust baseline already includes allocation-free message hashing and an
optimized Merkle root. Existing production methods remain the reference.

## Reproduce

From repository root, install Zig **0.15.2** and Rust **1.98.0**, then:

```sh
python3 zig/bench/run.py --zig /path/to/zig --samples 9
```

On the current Apple M3 Pro host, the default macOS 26.5 SDK stubs lack normal
arm64 symbols expected by Zig 0.15.2. Use the installed 15.4 SDK explicitly:

```sh
python3 zig/bench/run.py \
  --zig /tmp/ziggy-toolchain/zig-aarch64-macos-0.15.2/zig \
  --sysroot /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk \
  --library-dir /usr/lib --samples 9 --clean-build \
  --output zig/bench/results/release-safe
```

The harness compiles its Zig entry point directly, avoiding the host SDK issue
in Zig's separate `zig build` runner. This validates the benchmark executable;
the rewrite's build and test suite are validated separately. `--skip-build`
requires matching already-built binaries. `--only-differential` runs correctness
checks without performance trials. Python 3.9+ required. No RPCs or production
keys are read.

## Production baseline

`zig/reference` is a standalone Cargo workspace with a locked **path dependency
on the actual `rust/main/hyperlane-core` crate**. Its exact reference lockfile is
preserved losslessly as `Cargo.lock.gz` and restored/verified by
`python3 zig/tools/fixture_pack.py restore-locks` before every locked build.
Only the generated raw mirror is ignored; there is no unlocked first-run
reconciliation. See [helper lock closure](helper-locks.md) for all standalone
oracles, SDK-specific pins and the explicitly recovered Lander graph.
The exact generated lockfile SHA-256 is recorded as two concatenable 32-character
chunks in the results artifact. All source/corpus SHA-256 values use the same
explicit chunk format to satisfy that hook without bypassing it. Message encoding/decoding,
message IDs, Merkle ingestion/root, checkpoint signing hashes, and EIP-191
hashes execute production methods without source extraction or replacement
algorithms. The standalone crate preserves default core features: disabling
those exposes an existing `strum::Display` feature-unification requirement in
`hyperlane-application`.

The independent signature checker uses `k256 0.13.4`, the version used by the
Rust workspace. This is a crypto oracle, not an implementation of a complete
production signer or KMS backend.

Rust kernel builds use release mode, thin LTO, one codegen unit, and
`-C target-cpu=native`; Zig defaults to `ReleaseSafe` targeting the native CPU. Run a separate
`--optimize ReleaseFast` comparison. ReleaseSafe retains Zig runtime safety
checks; ReleaseFast disables them. Rust release has overflow checks disabled
by default, and its memory-safety model differs from Zig. These are explicitly
different safety configurations; report both Zig modes separately. These are
harness choices, not the production agent build configuration. The Rust version
is recorded; the agents' repository toolchain file pins 1.88.0, while 1.98.0 is
used here to support the available dependency lockfile/toolchain environment.

A separate full baseline build is attempted with:

```sh
cd rust/main
/usr/bin/time -l cargo +1.98.0 build --locked --release \
  -p relayer -p validator -p scraper -j 4
```

The working directory matters: `rust/main/.cargo/config.toml` supplies
`--cfg tokio_unstable`, which production agent metrics require. An initial
root-directory `--manifest-path` invocation missed that config and failed after
1,099.97 seconds. That diagnostic attempt is preserved in
`zig/bench/results/rust-full-build.log` and `rust-root-cwd-attempt.json`; it is
not a successful build baseline. The corrected working-directory attempt is
recorded separately in `rust-full-build-configured.log`. This is the real three-agent
baseline, including normal default-feature adapters and shared crates. A failed
build is recorded as a failure; its elapsed time is not a successful build-time
measurement. The dependency inventory in `rust-dependencies.json` counts the
unique normal-dependency union of those three binaries using `cargo tree`, with
Cargo's host-default target selection, and includes root/local crates. It is not
an independent count of external libraries or lines of code.

## Correctness gate

Before timing anything, both executables process the same seeded corpus:

- Existing `vectors/message.json` with its independently specified message ID.
- Every truncated header length, 0–76 bytes.
- Header integer/version boundaries and body lengths around Keccak block edges.
- 512 seeded random messages plus 64 KiB body cases.

For each valid message, the harness compares canonical encoding, the full
32-byte message ID, the incremental root after ingesting that ID, leaf count,
checkpoint signing hash, and EIP-191 digest. Invalid messages must be rejected
without advancing the tree. The corpus is reproducible from the Python source;
its SHA-256 and result count are saved in `differential.json`.

Signature checks use public disposable fixture keys, zero/all-one/random digests,
and two independently implemented cryptographic stacks. Rust signatures must
recover correctly in Zig, and Zig signatures must recover correctly in Rust.
Key-derived Ethereum addresses must agree; key=1 additionally checks the known
`0x7e5f4552091a69125d5dfcb7b8c2659029395bdf` address. Signature byte equality is
not required because deterministic nonce derivation differs. Both must reject
zero r/s, invalid v, r equal to the group order, and high-s signatures. This
supports interoperability; it is not a cryptographic audit or side-channel proof.

The strict k256 oracle models on-chain signature acceptance. The actual Rust
agent verifier accepts additional encodings. A second oracle links the exact
production ethers fork and records 21 recovery compatibility cases, including
EIP-155 v values and accepted high-s signatures, in
`zig/src/protocol/fixtures/ethers-recovery.json`. Its 51 transaction fixtures cover
legacy/EIP-1559 signing envelopes, hashes, canonical signed encoding, contract
creation, U256 field boundaries, access lists, and RLP length boundaries. Regenerate
with `python3 zig/reference/evm/generate.py`; source/revision/schema are documented
in `zig/src/evm/fixtures/README.md`. These protocol fixtures do not validate RPC,
nonce management, execution, fee policies, or whole-agent behavior.

## Timing gate

Each kernel runs once as warmup, then nine measured samples by default.
Language order alternates each trial. Each sample runs in a fresh process;
only the inner kernel loop is timed. The default `ReleaseSafe` run is the
acceptance comparison; keep optional `ReleaseFast` output in a separate
`--output` directory and label it explicitly. Deterministic checksums prevent dead-code
elimination and must agree across languages and repetitions.

| Kernel                    | Semantics                                                             |
| ------------------------- | --------------------------------------------------------------------- |
| `message_id`              | Mutate nonce; hash canonical fields/body without owned encoding       |
| `message_roundtrip_owned` | Allocate canonical encoding; decode to independently owned body; hash |
| `merkle_ingest`           | Ingest deterministic 32-byte leaves; compute final root               |
| `merkle_ingest_root`      | Ingest deterministic leaves; compute a root after each ingestion      |

Message body sizes are 0, 64, 1,024, and 65,536 bytes. Counts are fixed per case
and recorded. Rust uses its system allocator; Zig uses `std.heap.smp_allocator`.
The owned case explicitly copies Zig's borrowed decoded body to preserve Rust's
ownership semantics. Allocation implementations still differ and affect results.

Raw samples, medians, min/max, standard deviations, maximum resident sizes
(macOS), binary sizes, toolchains, source hashes, build commands/cache status,
and host metadata are written to `protocol-kernels.json`. Rust/Zig is the ratio
of median nanoseconds: >1 means Zig was faster in that case. RSS includes process
runtime and is not an incremental allocation measurement. No confidence
interval, pinned-core, frequency-lock, or bare-metal isolation claim is made.
Run when no compilation or other CPU-heavy job is active. `--clean-build`
uses fresh task-owned Rust target and Zig local/global compiler cache directories,
retaining downloaded dependencies. These directories are removed after the run.
Clean **protocol harness** build timings remain feature-incomparable to full
agent builds and must never be presented as whole-agent build improvements.

## Production packed prover comparison

`zig/bench/prover.py` compares unchanged production Rust `PackedMerkle` (direct
source inclusion) with `zig/src/relayer/prover.zig`. The historical-query schedule
uses root index `(query * 7919) % leaves` and leaf index
`(query * 104729) % (root_index + 1)`; latest-root queries use the final root.
Proof construction is timed; building the identical prepopulated tree and
verifying proofs are outside the proof timer. Ingestion times maintaining the
cached current root. All 32 siblings are consumed and the checksum must match.

The 82 differential queries span 15 tree sizes (1..65,537), chunk/power-of-two
boundaries, first/middle/last leaves and historical roots. The Rust wrapper also
checks each proof root against the actual independent production IncrementalMerkle
prefix root. Both safety modes pass. Artifacts retain the chunked proof vectors.

```sh
python3 zig/bench/prover.py --zig /path/to/zig-0.15.2 --sysroot SDK --optimize ReleaseSafe --build-only
python3 zig/bench/prover.py --zig /path/to/zig-0.15.2 --sysroot SDK --optimize ReleaseFast --build-only
# Pause team compiler/test jobs before timing; preserve unrelated user work.
python3 zig/bench/prover.py --zig /path/to/zig-0.15.2 --sysroot SDK --optimize ReleaseSafe --skip-build
python3 zig/bench/prover.py --zig /path/to/zig-0.15.2 --sysroot SDK --optimize ReleaseFast --skip-build
```

Each mode retains all six cases and nine fresh-process samples, alternating
language order after warmup. Native CPU, Rust thin-LTO/one codegen unit and
system allocator versus Zig smp allocator; different safety models remain.
Current outputs are under `packed-releasesafe` and `packed-releasefast`. Their
`leaves=0` ingestion argument means no prebuilt tree: `iterations` is its final
leaf count. The Markdown tables show that count directly. Source/binary identities
and load averages are recorded. Team jobs were idle during the measured window,
but unrelated CPU-heavy user work continued; no uncontended-host claim is made.

## Whole-agent acceptance still required

The complete replacement requires matched Rust/Zig runs of the same captured
agent workloads, chain protocols, configuration, databases, and failure schedule.
Capture processed messages/s, prepare-to-confirm latency p50/p95/p99, RPC calls,
retry/recovery behavior, validator signing/output byte parity, scraper row/state
parity, peak RSS, disk bytes/fsyncs, restart time, clean build time, binary size,
and dependency/LOC inventories at a fixed feature set. Require equality and
safety invariants before comparing performance. Include timeouts, partial writes,
reordering, duplicates, reorgs, crashes at persistence boundaries, nonce races,
RPC disagreement, and signer failures. Real-chain shadow validation and
controlled testnet deliveries follow simulation; production signing/execution
cutover needs its own evidence and operational authorization.

Incomplete Zig functionality cannot be counted as a LOC, dependency, binary,
build-time, or throughput win over a complete Rust agent. The kernel results
inform architecture and optimization decisions only.

## Actual validator daemon comparison

`python3 zig/bench/validator.py --samples 5 --catchup 32 --steady 8`
executes the existing production Rust validator and native Zig validator against
fresh disposable Anvil instances. Both receive the same normal-mode settings:
two majority RPC endpoints, public key11 for checkpoint and transaction signing,
LocalStorage, zero reorg depth, one-second role/index intervals, 50 maximum signing
concurrency. The preserved initial/cache snapshots used the earlier serial Zig
publication implementation. The current implementation uses a persistent bounded
native signing/publication pool (256KiB stack per actual worker); final matched
measurements must record its thread count and RSS. Rust uses async `join_all`.
The newer native/KMS concurrency fixtures are correctness evidence and do not
replace historical timings. Deployment/trace generation bypass counting proxies. Both processes
must actually self-announce, index and sign; per-index roots/message IDs must match
production Rust core and every signature must recover the configured address via
the actual production ethers fork.

Each fresh process starts after 32 pre-generated dispatches, then receives eight
new dispatches on an independent one-second schedule. The schedule does not wait
for signing, avoiding feedback that would change offered load for a faster agent.
Catchup completion requires every checkpoint object, latest pointer and covering
snapshot. Freshness ends when the same durable object/pointer/snapshot condition
holds for each new index. Poll granularity is 5 ms; actual dispatch offsets are
recorded. The harness alternates Rust/Zig then Zig/Rust across five sample pairs.

`wait4` measures each daemon's actual CPU time and peak RSS; process wall time and
shutdown latency are separate. RPC counts include every application JSON-RPC
operation through both proxies, including retries and ancillary provider reads.
Anvil, trace-generation subprocesses and post-run reference checks are outside
the measured process. Proxy overhead is shared by both implementations. Binary
sizes/hashes, load averages and active process inventories accompany raw results.
No user workloads are stopped; initial samples explicitly include compiler load.
A separate coordinated team-idle rerun is required before authoritative comparison.

Durability differs: Zig requests per-transition RocksDB WAL fsync and atomic
checkpoint publication with file/directory fsync; production Rust LocalStorage
uses direct Tokio file writes without those explicit durability operations.
Production Rust runs tracing, Prometheus and Tokio metrics; initial Zig daemon
telemetry is incomplete. Rust exits under default SIGTERM, while Zig drains its
worker. These differences remain explicit and prevent an all-feature-equivalent
whole-agent speedup claim. This workload covers EVM/local signing/local storage;
it does not represent other VMs, KMS/cloud storage, lightweight/websocket modes,
reorg recovery throughput or a deployed sustained mainnet workload.

`whole-validator-smoke` preserves the initial harness signature-validation failure
(Rust U256 signature components use minimally sized hex; the oracle needs padded
32-byte values). `whole-validator-smoke2` verifies the correction but uses a
feedback-paced two-event trace, so it is nonacceptance evidence. The fixed-arrival
five-pair results live under `whole-validator-initial` and remain provisional.

The initial RPC breakdown (`whole-validator-initial/rpc-analysis.json`) explains
most of the request regression: median `eth_getBlockByNumber` 7→267,
`eth_call` 37→95 and `eth_getLogs` 8→49. The concrete EVM role re-fetched each leaf's
block, even when the current round had already obtained and fenced that complete
range. The subsequent cache reuses only observations from a successfully stored,
fully authenticated `Indexer.Batch`, retaining exact leaf/index/height/hash and
clearing on every round. Cache misses retain the original canonical read. All
vote hash fences and signed-prefix audits remain; no polling interval is reduced.
The lying-reader, growing-fork, restart and hanging-endpoint integration passes
with this change, including the actual service binary.

`whole-validator-profile-initial` is a separate diagnostic run with 128 backlog
messages and a 5-second macOS `sample` capture of the exact original Zig binary.
Its wall-clock stacks include native HTTP waits, secp256k1 recovery under signing
and storage authentication, and file/WAL sync. Sampling includes sleeping threads
and profiler overhead; stack counts are not percentages of CPU or acceptance
benchmark results. Initial `wait4` medians split Rust CPU into 0.192s user/0.070s
system, Zig into 0.487s user/0.524s system. The cache targets duplicate HTTP/parser/
DB work; stronger durability and signature authentication are preserved.

The authenticated-batch-cache snapshots are additional rows, preserving the
original results: `whole-validator-cached-releasesafe` and
`whole-validator-cached-releasefast`. Both contain five Rust/Zig process pairs,
independent fixed arrivals and 400 verified checkpoints per mode. Their separate
mode binaries retain real service, native database and HTTP dependencies.
[The validator snapshot summary](../../zig/bench/results/whole-validator-summary.md) retains five comparative metrics per implementation for all five completed snapshots, including CPU/RPC/RSS regressions. [The results tables](results.md) retain the additional process metrics, failed oracle and workload limits. Initial and cached snapshots ran under different shared load and
are not a causal isolated measurement of the cache alone.

Build separate actual service binaries reproducibly:

```sh
python3 zig/bench/build_validator.py --zig /path/to/zig \
  --sdk-root /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk \
  --native-db-libs-file /path/to/seven-archive-paths.txt
python3 zig/bench/validator.py --zig zig/zig-out/bin/validator-releasesafe \
  --zig-mode ReleaseSafe --samples 5 --catchup 32 --steady 8 \
  --output zig/bench/results/whole-validator-final-releasesafe
python3 zig/bench/validator.py --zig zig/zig-out/bin/validator-releasefast \
  --zig-mode ReleaseFast --samples 5 --catchup 32 --steady 8 \
  --output zig/bench/results/whole-validator-final-releasefast
```

Use `--team-idle` only after coordinating the actual timing window. The harness
pins binary copies by digest before process execution and records a pruned source
inventory. Binary digests identify the measured artifacts; the source inventory
is captured at harness start and may contain concurrent edits after compilation.
Fresh process/database does not imply cold filesystem or native-library caches.

New builds also record pruned source inventories before and after compilation,
plus every native archive hash. `source_unchanged_during_build` distinguishes a
stable compilation input inventory from a build concurrent with edits. This
metadata is additional provenance; it does not retroactively pin older builds.
The seven standalone RocksDB archives include the runtime ABI guard and match
`zig/native/rocks/out-final/manifest.json`.

Additional correctness evidence, outside performance samples:

- `validator-evm-rpc-metrics-integration.json`: rebuilt actual executable,
  primary/quorum physical request labels, GET/HEAD metrics, checkpoint progress
  during a physically stalled receipt request, identical restart outputs/nonce.
- `validator-task-native/results.json`: native mailbox durability and independent,
  allocation-only checkpoint/announcement constructors.
- `scraper-telemetry-fatal/scraper-process.json`: actual PostgreSQL/Solidity scraper,
  same-port restart, progress during receipt stalls and durable fatal reorg guard.

These tests do not replace the pending final matched workload comparison.

For new paired relayer runs, `launch_to_caught_up_messages_per_second` divides
that trial's verified unique, initially undelivered backlog by the full interval
from daemon launch to observation that every backlog message was delivered. The
pre-launch fixture performs one direct `delivered` query per message, outside
the daemon timer and included in fixture RPC counts. `post_readiness_catchup_ms`
retains the partial interval after readiness as latency only: some deliveries
may already precede readiness, so it cannot supply the denominator for all
backlog messages. The full interval must be positive; no millisecond clamp is
used. This delivery-completion rate excludes the subsequent, unchanged
600-second confirmation/retirement and same-database restart checks. Historical
result files keep their original bytes and field meanings. The immutable Linux
method authority records this corrected definition for future runs.

The earlier303-vs-98 RPC snapshot used explicit `rpcConsensusType="majority"`,
which both production Rust and the Zig settings oracle interpret as checkpoint
consensus. It is not a classic/null-consensus fallback measurement. Its extra
prefix authentication, fences and stronger durability remain qualified above.
A separate source-parity bug made classic fallback race every checkpoint across
all peers. The corrected normal path performs bounded startup readiness, retains
one healthy primary and rotates only on an actual failed data read. Explicit
majority/quorum denominators and full fanout remain unchanged.

Role-level correctness/request accounting (not whole-agent performance):

| Local workload                                        |           Before |           After | Evidence                                  |
| ----------------------------------------------------- | ---------------: | --------------: | ----------------------------------------- |
| EVM,3 checkpoints/3 healthy fallback peers            |         114 RPCs |         51 RPCs | `validator-classic-fallback.json`         |
| Generic Tron HTTP bridge,12 checkpoint rounds/2 peers | 12+12 tree reads | 12+1 tree reads | `validator-generic-classic-fallback.json` |

EVM and generic actual-error cases rotate to the secondary and preserve3
Rust-matching roots. The unchanged majority/fork/restart integration suites also
pass. For protocols where domain/owner authentication requires the actual state
account/frontier, the first generic readiness round reads that frontier; later
normal rounds use only the retained primary. This is not represented as a cheap
standalone identity probe. Use `--consensus fallback` to run a separate matched
whole-validator scenario; previous explicit-majority results remain intact.

The final source/build inventory is prepared by `zig/bench/inventory.py` and
`zig/bench/build_matrix.py`. Inventory separates implementation, inline/dedicated
tests, fixtures/reference harnesses, vendored native sources and build tools;
physical line counts are lexical accounting, not semantic equivalence. Packed
fixtures and lockfiles are counted once, excluding ignored raw mirrors and all
compiler/target outputs. Native dependency counts are a union of locked package
identities, separately from the Rust production lockfile and resolved default
feature graph. The agents require native RocksDB/compression, curl, libpq and
optional Rust SDK/crypto/proving/regex helpers; there is no zero-dependency claim.

`results/build-matrix-plan/plan.json` records commands for dependency-inclusive
native SDK phases, optional SDKs, all-three-agent cold compilation and no-change
incremental compilation in Rust and both Zig release modes. Planning does not
execute a build. Cold phases require fresh isolated targets/caches and sufficient
free disk; existing production targets are preserved. The previous1017s Rust
build reused cache and must not be placed in a cold-build comparison. Registry,
git-source and toolchain downloads are excluded from the planned cold phases;
prebuilt-SDK compiler-only timing is explicitly distinguished from full native
prerequisite timing. Final measurements require a coordinated compiler-idle
window and source/binary identities, with all failures/regressions retained.

Additional process correctness artifacts: `validator-wss-process.json` covers
real trusted WSS, source-mode cutover, zero lightweight RPC event indexing,
reconnect, restart and concurrent snapshot history repair;
`validator-guard-sigterm-process.json` covers uncertain actual guard fsync and
nonzero SIGTERM/restart exits. `scraper-cpu-fixed-correctness/` preserves the
post-fix scraper process acceptance and intrusive shared-host SQL/CPU attribution
separately. Its494-to8 SQL count change and idle-wait diagnosis are not matched
throughput measurements; the large sample stacks remain in the original `/tmp`
artifacts. Earlier process results and unsuccessful full-test runs remain visible.

The read-only Ethereum observer is now paused before final timing work. Immutable
`ethereum-shadow-sustained/five-hour-manifest.json` covers19,024.7 active seconds,
1,571 contiguous finalized blocks26350112 through26351682 and147 dispatches plus
147 insertions, with Rust codec/ID/count parity. The first-hour snapshot remains
separate. The running observer counted HTTP/network forwarding failures but did
not count every JSON-RPC/loop retry; its last `EndpointError` is preserved. The
full five-hour capture must not be described as zero endpoint errors. This is
read-only protocol/event observation, with no signing/publication/broadcast or
full-agent mainnet-parity claim.

`build-matrix-final-command.json` prepares the exact isolated all-eight-feature
build command without executing it. SDK phases record their produced libraries
as artifacts in addition to the three agent binaries and Aleo worker. The
source inventory parses committed chunked dependency-lock artifacts directly,
so dependency counts do not depend on ignored restored Cargo.lock files being
present. Restoration occurs before measured locked builds. The native SDK union
and Rust lock/resolved graphs remain distinct accounting scopes.

The optional `--reclaim-phase-caches` mode limits accumulated build disk usage
without changing measured compiler intervals. Every successful phase first
records its result. Reclamation then preserves original runtime artifact paths,
creates digest pins, retains matching dylib install-ID/dependency paths and
public runtime assets/licenses, and verifies libraries load before and after.
Only compiler outputs beneath the fresh marked task cache are removed. The Rust
and each Zig cache remain intact through their paired no-change phase; there is
no subsequent hot-cache claim after reclamation. User global caches, toolchains,
registry/Git sources and downloaded runtime parameters remain untouched.

Each reclamation has a preservation plan, artifact hashes, deletion totals and
observed free-space delta. Physical-byte attribution is qualified for hardlinks,
APFS clones and unrelated host writes. Conservative phase budgets estimate
28.95GiB maximum retained data for the full all-eight build with reclamation,
plus8GiB headroom; the explicit40GiB preflight floor remains unchanged. The
actual2GiB in-run disk guard and all failed rows remain. Without reclamation the
plan estimates the larger accumulated target footprint and raises the required
free-space threshold accordingly. These are planning estimates, not measured
build outcomes.

Seven safety tests include an actual compiled dylib dependency/install-ID that
still executes after cleanup, exact native archive/license retention, rejection
of symlink/unmarked escape paths, preservation of compiler dependencies through
the phase-scheduler no-change boundary, and actual Cargo verification that empty
Rust wrapper environment overrides configured compiler-cache wrappers. Inherited
cache-control signatures are recorded; Rust/workspace wrappers are disabled,
C/C++ caches are disabled and explicit cache-wrapper compiler commands reject
execution rather than being called cold. Test evidence:
`cache-reclamation-second/reclaimer-unit-tests.log`.

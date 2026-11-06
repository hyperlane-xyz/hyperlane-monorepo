# Rust → Zig agent rewrite: scope and parity contract

Audit baseline: `c5202242cc6569da4a858ed7ddbb34170ab696aa`.
Measured from this checkout on 2026-11-05. Inventory is source inspection, not evidence
that the Rust suite or any Zig agent has passed. This file records the complete
requested destination; implementing a subset does not complete the rewrite.

## Boundary

Replace the offchain relayer, validator, and scraper, including their shared runtime,
indexers, chain access, storage, signers, metadata, transaction submission, configuration,
metrics, and operational HTTP interfaces. Preserve the existing deployed contract wire
formats and observable supported behavior. Keep the Rust implementation usable as the
reference and rollback implementation until parity and migration gates pass.

`rust/sealevel` contains onchain programs and libraries imported by offchain code.
Rewriting those programs is outside an **agents** rewrite. Their data layouts,
instructions, program-derived addresses, and integration fixtures remain contracts the
Zig implementation must obey. TypeScript tooling, infrastructure consumers, and the
scraper proxy also remain consumers whose integration contracts must be preserved.

The inspiration mentions zero dependencies, deterministic simulation, lower LOC, and
faster builds. None is an already established result for this codebase. Zero external
dependencies was not an explicit requirement. Do not silently replace full feature
coverage with a small standalone simulator to obtain those numbers.

## Measured source inventory

Counts are physical lines in every `*.rs` recursively under each listed directory,
including blank lines, comments, generated code, and tests. Directories in this table
are disjoint. These are **not production-only LOC** or executed-test counts.

| Area under `rust/main`                 | Rust files | Physical lines |
| -------------------------------------- | ---------: | -------------: |
| `agents/relayer`                       |        100 |         49,059 |
| `agents/validator`                     |         16 |         13,960 |
| `agents/scraper` (including migration) |         98 |         18,643 |
| `lander`                               |        177 |         39,562 |
| `hyperlane-base`                       |         78 |         27,191 |
| `hyperlane-core`                       |         60 |         10,562 |
| `chains`                               |        230 |         49,333 |
| `applications`                         |          8 |            162 |
| `ethers-prometheus`                    |          5 |          1,363 |
| `hyperlane-metric`                     |          4 |            603 |
| `hyperlane-test`                       |          4 |            248 |
| `utils` (including local E2E harness)  |         52 |         12,357 |
| **Entire `rust/main`**                 |    **832** |    **223,043** |

The three agent directories total **81,662 physical lines**. Their shared code is
part of the rewrite; comparing only that subtotal with Zig's full implementation
would undercount the Rust side. Conversely, comparing an incomplete Zig kernel with
the whole workspace would inflate apparent savings.

Workspace manifest: 27 explicit members, 170 declared workspace dependencies. Agent
manifests declare 51/30/21 normal dependencies for relayer/validator/scraper and
14/13/7 development dependencies respectively. Optional and path dependencies are
included in these manifest counts; transitive dependencies are not.

`rust/main/Cargo.lock` contains **1,430 package records**: 1,292 registry-sourced,
96 git-sourced, and 42 without a source field. That lock includes local Sealevel
packages and tests. It is not the resolved production dependency closure of each
agent; compute that separately per target and feature set before advertising a
reduction. Scraper's migration source contains 21 `m*.rs` migration files.

There are **2,134** literal `#[test]` / `#[tokio::test(...)]` attributes across
`rust/main`. This lexical count excludes some parameterized tests and does not
measure coverage, test discovery, executed cases, or passing cases.

Reproduce the basic inventory from the repository root with Python 3.11+:

```sh
python3 - <<'PY'
from pathlib import Path
import re
import tomllib
root = Path('rust/main')
files = sorted(root.rglob('*.rs'))
files = [p for p in files if 'target' not in p.parts]
for area in ('agents/relayer', 'agents/validator', 'agents/scraper', 'lander',
             'hyperlane-base', 'hyperlane-core', 'chains', 'applications',
             'ethers-prometheus', 'hyperlane-metric', 'hyperlane-test', 'utils'):
    selected = [p for p in files if p.is_relative_to(root / area)]
    print(area, len(selected), sum(len(p.read_text().splitlines()) for p in selected))
texts = [p.read_text() for p in files]
print('total', len(files), sum(len(s.splitlines()) for s in texts))
print('test attributes', sum(len(re.findall(
    r'#\[(?:tokio::)?test(?:\([^\]]*\))?\]', s)) for s in texts))
manifest = tomllib.loads((root / 'Cargo.toml').read_text())
packages = tomllib.loads((root / 'Cargo.lock').read_text())['package']
print('workspace members', len(manifest['workspace']['members']))
print('workspace dependencies', len(manifest['workspace']['dependencies']))
print('locked package records', len(packages))
PY
```

## Runtime and subsystem inventory

| Subsystem             | Existing source entrypoints                                                                                                                        | Required preserved behavior                                                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent process         | `hyperlane-base/src/agent.rs`, `agents/*/src/main.rs`                                                                                              | Configuration construction, task supervision, cancellation, orderly shutdown, bounded work, readiness                                                                                                                                |
| Configuration         | `hyperlane-base/src/settings/{loader,parser,chains.rs,signers.rs,checkpoint_syncer.rs}`, `agents/*/src/settings*`                                  | File/env/argument precedence, names and aliases, protocol-specific values, custom endpoint replacement, rejection of obsolete unsafe settings, secret redaction                                                                      |
| Core wire types       | `hyperlane-core/src/types/{message,checkpoint,announcement}.rs`, `traits/encode.rs`                                                                | Byte-exact message, checkpoint, announcement, integer/address and signature encoding                                                                                                                                                 |
| Merkle trees          | `hyperlane-core/src/accumulator`, `agents/relayer/src/{prover,merkle_tree}`                                                                        | Depth-32 zero hashes, roots, proofs, insertion order, bounded counts, snapshot layout/authentication, prefix recovery                                                                                                                |
| RPC                   | `hyperlane-core/src/rpc_clients`, `chains/*/src`                                                                                                   | Timeout/retry/fallback semantics, endpoint identity, numeric precision, protocol finality, stale/error classification, metrics                                                                                                       |
| Contract indexing     | `hyperlane-base/src/contract_sync`, `scraper_websocket`                                                                                            | Forward/backward/rate-limited/sequence-aware cursors, replay, ordered insertions, bounded queues, gap detection, restart persistence                                                                                                 |
| Relayer intake        | `agents/relayer/src/{relayer,msg,db_loader,relay_api,scraper_websocket}`                                                                           | Durable discovery, scraper authority/fallback, matching lists, denylist/blacklist, retry/reprocessing, gas policies, bounded ingress and caches                                                                                      |
| ISM metadata          | `agents/relayer/src/msg/metadata`                                                                                                                  | Routing, aggregation, message-ID multisig, Merkle-root multisig, null, CCIP-read, Sealevel composite paths; recursive selection, signature ordering, proof selection, cache invalidation                                             |
| Submission            | `lander/src/{dispatcher,adapter,payload,transaction}`, relayer submission paths                                                                    | Build → simulate/estimate → submit → inclusion → finality; chain-specific batching, nonce recovery, replacements/escalation, stale recovery, MEV settings, persisted transaction/payload links                                       |
| Validator             | `agents/validator/src/{validator,submit,checkpoint_consensus,merkle_tree_hook_sync,reorg_reporter}.rs`                                             | Local-history authentication, finality-aware consensus, signing readiness, announcements, background publication, snapshots, fail-closed reorg handling                                                                              |
| Key management        | `hyperlane-base/src/settings/signers.rs`, `chains/hyperlane-ethereum/src/signer`, chain signers                                                    | Local signing, AWS KMS, GCP KMS with ambient credentials, supported chain key/address forms, correct digest/recovery/low-S behavior, singleton serialization and bounded signer initialization                                       |
| Checkpoint storage    | `hyperlane-base/src/traits/checkpoint_syncer.rs`, settings and storage implementations                                                             | File/S3/GCS layouts, JSON/signature compatibility, latest index, snapshots, announcement/reorg marker formats, publication order and retries, ambient auth                                                                           |
| Local durable storage | `hyperlane-base/src/db`, `lander/src/dispatcher/db`                                                                                                | RocksDB key/value compatibility or verified migration; checkpoints, source/derived indexes, rollback WAL continuity, transactions, restart recovery before new writes                                                                |
| Scraper               | `agents/scraper/src/{near_head,db,store,reconciliation,ccr}`                                                                                       | Canonical near-head ingestion and confirmation, per-domain writer lease, atomic events/frontiers, reorg rewind, confirmed-conflict halt, receipt enrichment, confirmed views, notifications, reconciliation, optional same-chain CCR |
| Scraper schema        | `agents/scraper/migration`                                                                                                                         | Existing PostgreSQL schema/types/views/indexes, managed-index verification, migration history and init behavior, idempotency/concurrency guarantees                                                                                  |
| Operator interfaces   | `hyperlane-base/src/server`, `agents/relayer/src/{server,relay_api}`, `agents/validator/src/server`                                                | Metrics/readiness, queue inspection/retry/reprocessing, message/Merkle insertion inspection, proofs, gas rule CRUD, runtime denylist, nonce overrides; preserve opt-in sensitive endpoints                                           |
| Deployment            | `rust/Dockerfile`, `rust/main/helm/hyperlane-agent`, `.github/workflows/{rust,rust-docker,rust-release,agent-release-artifacts,test-rust-e2e}.yml` | Linux binaries/images, non-root user, TLS CA bundle, config/app contexts, persistent volumes, exit/readiness contracts, CI path filters, artifact provenance                                                                         |

An enum variant is not proof of an implemented path. `ModuleType` includes more
protocol module identifiers than the metadata builder supports. Preserve implemented
behavior and explicit unsupported errors; do not silently accept unsupported ISMs.

## Protocol matrix

`HyperlaneDomainProtocol` and `ChainConnectionConf` declare eight protocols backed
by seven chain crates. Presence below records scope; each concrete agent operation
still needs its own parity test.

| Protocol      | Chain crate          | Important transport/encoding coverage                                                                                       |
| ------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Ethereum      | `hyperlane-ethereum` | JSON-RPC HTTP/WebSocket, EVM ABI/logs, EIP-191 signing, legacy/EIP-1559 transactions, chain-specific finality/gas           |
| Sealevel      | `hyperlane-sealevel` | Solana RPC, accounts/instructions, Borsh, PDA derivation, versioned txs, ALTs, composite ISMs, compute budget/priority fees |
| Cosmos Wasm   | `hyperlane-cosmos`   | Tendermint/CometBFT RPC and gRPC, protobuf, CosmWasm query/execute, Bech32 and account sequence                             |
| Cosmos Native | `hyperlane-cosmos`   | Native module protobuf/query/transaction conventions; distinct from Wasm                                                    |
| Starknet      | `hyperlane-starknet` | JSON-RPC, felts, Stark curve/account signing, account transaction versions and fee conventions                              |
| Radix         | `hyperlane-radix`    | Core/Gateway APIs, SBOR, manifests, Radix transaction hashing/signatures                                                    |
| Aleo          | `hyperlane-aleo`     | Feature-gated `aleo`; snarkVM execution/proving, program data, key/signature formats, VM lifecycle and resource behavior    |
| Tron          | `hyperlane-tron`     | Wallet/solidity endpoints, protobuf/raw tx IDs, address forms, solidified-state finality and signing                        |

Existing Lander is **not complete for every configured protocol**:
`lander/src/adapter/chains/factory.rs` has `todo!()` for Starknet and Cosmos Native;
`adapter/chains/cosmos.rs` is a placeholder with `todo!()` operations. Determine the
existing legacy submission path per protocol before selecting the corresponding
Zig parity tests. Reproducing a placeholder is not new working coverage; implementing
new coverage should be reported separately from parity.

Per-method placeholder inventory (16 `todo!()` sites in chain implementations):

| Source under `rust/main/lander/src/adapter/chains` | Method/construction missing        |
| -------------------------------------------------- | ---------------------------------- |
| `ethereum/adapter.rs:424`                          | `estimate_gas_limit`               |
| `tron/adapter.rs:64`                               | `estimate_gas_limit`               |
| `radix/adapter.rs:315`                             | `estimate_gas_limit`               |
| `aleo/adapter/core.rs:63`                          | `estimate_gas_limit`               |
| `cosmos.rs:35`                                     | `estimate_gas_limit`               |
| `cosmos.rs:39`                                     | `build_transactions`               |
| `cosmos.rs:43`                                     | `simulate_tx`                      |
| `cosmos.rs:47`                                     | `estimate_tx`                      |
| `cosmos.rs:51`                                     | `submit`                           |
| `cosmos.rs:58`                                     | `get_tx_hash_status`               |
| `cosmos.rs:65`                                     | `reverted_payloads`                |
| `cosmos.rs:69`                                     | `estimated_block_time`             |
| `cosmos.rs:73`                                     | `max_batch_size`                   |
| `cosmos.rs:77`                                     | `update_vm_specific_metrics`       |
| `factory.rs:56`                                    | Starknet adapter construction      |
| `factory.rs:57`                                    | Cosmos Native adapter construction |

The shared `adapter/core.rs:146,151` additionally leaves default
`nonce_gap_exists` / `replace_tx` outside the existing MVP, and the Ethereum test
helper at `chains/ethereum/tests.rs:256` has an EIP-2930 placeholder. There are
19 `todo!()` sites across all Lander Rust files, including that test helper.

Other methods in those adapters can still be implemented and used. Trace their
actual callers and legacy submission paths; the existence of one placeholder is
not evidence that an entire chain is unsupported.

Aleo is enabled in `rust/Dockerfile`'s production build. Omitting it from an initial
build is useful for iteration but cannot be described as complete production parity.
Its VM/proving dependencies are a distinct, large porting effort; replacing only
Aleo HTTP reads does not reproduce execution/proving.

## Security and durability invariants

1. Message bytes retain the 77-byte fixed header, big-endian u32 nonce/domains,
   full 32-byte addresses, and arbitrary body. Message IDs use Keccak-256, not
   standardized SHA3-256. Malformed/truncated network input must fail safely.
2. Preserve checkpoint domain separation and EIP-191 wrapping. A
   `CheckpointWithMessageId` digest covers domain hash, root, u32 index, message ID.
   Announcements have a separate domain hash. Never substitute a generic JSON hash.
3. Default validator agreement is `majority = ceil(2N/3)`. Existing `quorum` is
   `ceil(N/2)` including ties for even pools. Lightweight mode always uses majority.
   Exact duplicate URLs count once; failed endpoints retain denominator slots.
4. Authenticate endpoint roots against local insertion history at each endpoint's
   own index; matching later roots authenticate their prefix. Require the threshold
   at the selected index, including hook address/domain. An RPC frontier alone must
   never seed signing state. Persisted snapshots require the validator's own signed
   checkpoint authentication.
5. Threshold-confirmed conflict at committed history persists a reorg marker and
   halts. A checkpoint storage read error or existing reorg flag blocks startup.
   Preserve operator readiness and retry behavior without bypassing this state.
6. Never overwrite signed history or concurrently run two active signing writers
   against one key/state namespace. Preserve singleton signer sequencing and
   bounded KMS initialization. Credentials and private keys remain absent from
   logs, fixtures, reports, command output, and benchmarks.
7. Persist transaction/payload/nonce state before work can escape recovery control.
   Restart gates must reconstruct old work before admitting new submissions. Inject
   crashes before/after writes and external sends; do not equate replay with
   idempotence unless destination delivery is checked and persisted correctly.
8. Preserve finalized/confirmed frontiers separately from observed heads. Scraper
   provisional suffixes may rewind; confirmed-history conflicts halt that chain.
   Advance durable cursor/frontier atomically with the events it certifies.
9. Preserve RocksDB source/derived index reconciliation and archived WAL continuity
   or introduce a tested, reversible conversion with exact readback. New append-only
   state files do not make existing RocksDB data compatible.
10. Keep gas/fee arithmetic exact and bounded, cross-chain addresses untruncated,
    retry/backoff bounded, queues/caches explicitly bounded, and CCIP/network input
    limits enforced. Allocation failure, corrupt storage, overflow, and partial
    reads/writes must be explicit errors, never success defaults.

### Byte-level storage and signing contracts

These contracts differ from EVM ABI encoding and must have Rust-produced golden
fixtures before the Zig runtime reads production state:

- `hyperlane-core/src/traits/encode.rs`: stored `U256` is **32-byte little-endian**;
  stored `u32` and `u64` are **big-endian**; fixed hashes are raw bytes; stored bool
  is a single byte and rejects values other than 0 and 1. EVM ABI words and RLP
  integers remain big-endian. One shared generic integer codec would be wrong.
- `hyperlane-base/src/db/rocks/typed_db.rs`: RocksDB keys concatenate chain-name
  bytes, `_`, prefix, and encoded key. Single-value entries use the encoded false
  key `[0x00]`. Prefix iteration must distinguish `message_` from `message_id_`
  by the actual key shape. Pending-message migration validation reads RocksDB WAL
  sequence history; a replacement journal does not implement this operation.
- `hyperlane-core/src/traits/signing.rs`: signed checkpoint/announcement JSON has
  `value`, `signature`, and `serialized_signature`; readers accept `checkpoint`
  and `announcement` aliases for `value`. Signature object numeric formats and
  exact pretty/compact storage output need round-trip fixtures. Latest-index JSON
  and snapshot/reorg/announcement objects require separate format tests.
- Checkpoint signatures use the EIP-191-wrapped checkpoint signing hash;
  transaction signatures use the raw transaction digest. The generic signer must
  not choose the wrapper implicitly. Signer backends have differing raw/wrapped
  entrypoints, so adapters must apply exactly one checkpoint wrap.
- ECDSA has multiple valid signatures per key/digest. Compare recovered signer
  and verification behavior, plus exact encoding of an independently supplied
  signature. Byte equality of two newly generated signatures is not required.
  Test accepted `v` forms, high/low S, zero/out-of-range scalars and malformed
  encodings through actual ethers recovery and relevant destination verification.
  A stricter Zig signature boundary must be labelled an intentional behavior
  difference; it is not automatically Rust parity.
- Validator agreement at mixed endpoint indices authorizes the required-th
  highest matching prefix, not a threshold of identical `(root,index)` pairs.
  Preserve latest-first publication: newest signed checkpoint/index can be
  published before intermediate history, which must still be completed through
  the durable historical-signing queue. The pointer authenticates its target;
  it does not claim every older object already exists.
- Preserve the distinction between an existing checkpoint signed by this validator
  with a conflicting value (reorg guard/halt) and an object signed by another key
  (existing Rust warns/overwrites). Halt must discard late signer results and
  prevent subsequent writes; persist/retry the guard and fail closed on startup
  guard read/parse failure. Storage namespaces require one active writer.
- Local latest-index reads currently degrade some read/UTF-8 failures to no index;
  local checkpoint writes are not atomic. Record a preserve-or-fix decision and
  migration impact for each such behavior. Invariant 10 is the target for new
  safety boundaries, not a claim that every existing Rust path already follows it.

Additional full-parity test cases: URL normalization/deduplication compared with
Rust's `url` crate; relayer root-group poisoning by same-root/different-message-ID
checkpoints; on-chain validator signature ordering; Aleo's full-validator padding;
and scraper leases using the database clock/advisory locks rather than local time.
An in-memory fixed history capacity is a simulation bound, not a replacement for
the Rust validator's persistent insertion store and bounded sampled-root replay.

Authoritative behavior includes `agents/validator/README.md` and
`agents/scraper/README.md` in this baseline, their implementations, and their tests.

## Dependency policy

Use Zig standard library for the deterministic domain core, codecs where practical,
Keccak, scheduling primitives, configuration parsing, and local test harness.
Pin the Zig compiler and any vendored inputs with checksums/licenses. Treat compiler
and standard-library code as dependencies in supply-chain reporting even when the
package manifest has no external packages.

For full parity, choose audited libraries or documented system interfaces for TLS,
secp256k1/signature recovery, RocksDB compatibility, PostgreSQL authentication/wire
protocol, cloud identity/KMS/storage, and specialized chain cryptography/proving.
Keep each behind a small explicit interface so the deterministic kernel can simulate
it. A C ABI binding is a dependency, not a zero-dependency result. A sidecar or Rust
FFI can be a migration bridge but means the rewrite still has a Rust runtime
component. Report that honestly; retire it only after a verified replacement exists.

Do not reimplement all specialized crypto and proving systems merely to make a
dependency counter zero. If strict zero external dependencies becomes a requirement,
expand the delivery scope and verification requirements explicitly rather than
silently dropping protocols or cloud/storage features.

## Implementation sequence and completion gates

| Stage | Deliverable                                                                 | Gate                                                                                                                                 |
| ----- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Frozen Rust revision, capability matrix, fixtures and benchmark runner      | Repeatable baseline; compiler/OS/CPU/features/cache policy recorded                                                                  |
| 1     | Zig core: wire types, Keccak, hashes, Merkle roots/proofs, exact arithmetic | Differential results against actual Rust implementations and shared contract vectors; malformed input tests                          |
| 2     | Deterministic scheduler/state machines with explicit clock/random/IO        | Seeded fault traces reproducible; no loss, duplicate terminal transitions, invalid signing or frontier advance under injected faults |
| 3     | Durable store, config/runtime, metrics and networking                       | Crash/restart recovery, migration round trips, config/API compatibility and secret redaction                                         |
| 4     | EVM validator/relayer/scraper vertical slice                                | Same local-chain workloads and protocol outputs as Rust, independent signers/state namespaces; fault/reorg scenarios                 |
| 5     | All remaining adapters and specialized submission/proving                   | Per-protocol parity matrix complete, existing supported E2E scenarios rerun against Zig                                              |
| 6     | Operational interfaces, cloud backends, container/Helm/CI integration       | KMS/storage integration tests, readback of persisted state, lifecycle/probe compatibility; no placeholder path reported as ready     |
| 7     | Matched full-agent performance experiments                                  | Same workload/semantics/durability/features; raw samples and correctness checks retained                                             |
| 8     | Shadow observation and controlled migration qualification                   | No signing/state conflicts; rollback rehearsed; production activation separately evidenced                                           |

Independent workers can own core/codec, deterministic runtime/storage, chain adapters,
and benchmark/replay tooling. Shared interfaces and fixture formats must be agreed
before writing overlapping entrypoints/build files. Reviews should be independent of
the code author and include the security invariants above.

Existing verification targets to preserve/adapt:

```sh
cd rust/main
cargo fmt --all --check
cargo clippy --features aleo,integration_test -- -D warnings
cargo test --all-targets --features aleo,integration_test
cargo test -p scraper -p migration -- --test-threads=4
cargo run --release --bin run-locally
```

These are baseline commands, not claims that they ran in this audit. Docker is needed
for scraper PostgreSQL integration tests. Existing CI E2E matrix:
`cosmwasm`, `cosmosnative`, `evm`, `sealevel`, `sealevel-composite`, `starknet`,
`radix`, `tron`; Aleo must receive separate parity coverage because its absence from
that matrix does not remove its production build feature.

## Benchmark contract

Report at least: clean and incremental optimized build wall time, peak build RSS,
artifact size, dependency closure, comparable source/test/generated LOC; steady-state
throughput, latency distribution, CPU, peak/steady RSS, allocation counts/bytes,
RPC calls, persisted bytes/write amplification, and restart/replay duration.

Use the same target, CPU policy, feature set, workload ordering/seed, input sizes,
error distribution, finality policy, signing backend, network delay, and durability
mode. Alternate implementation order and retain multiple raw samples; separate
warmup from measured runs and report sample count/dispersion. Record host contention.
Use workload-level checksums/invariants to detect optimized-away work or mismatches.

Kernel microbenchmarks are useful but are not full-agent benchmarks. Label copied
standalone Rust algorithms as such; the genuine Rust baseline must call existing
crate APIs. In particular, borrowing a message body in Zig versus copying it in
Rust is a semantic/allocation difference worth investigating, not pure evidence
that one language executes the same operation faster. Either benchmark both owning
and borrowed forms or disclose that distinction explicitly.

Do not extrapolate a hash/codec speedup to relayer delivery latency. RPC, finality,
cloud signing, durable writes, metadata availability, and proving can dominate.
No 10× LOC or 7× build claim is justified until the compared implementations pass
the same full parity matrix and the corresponding measurements exist.

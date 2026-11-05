# Rust → Zig agents

## Objective

Replace the relayer, validator, scraper, their shared runtime, and supported chain
adapters with Zig. Preserve protocol bytes, finality, durable recovery, signing
boundaries, configuration, operator APIs, and deployed storage contracts. Measure
the Rust and Zig implementations on equivalent workloads before proposing cutover.

The Tempo numbers are motivation, not acceptance criteria. A smaller program that
omits an adapter, storage backend, or recovery path is not an equivalent rewrite.

## Execution

Work in this checkout on `feat/zig-agent-rewrite`. Keep Rust available as the
reference and rollback implementation until the gates below pass. No production
key use, checkpoint publication, transaction submission, or deployment is needed
to build and benchmark the replacement.

| Stage                   | Deliverable                                                                                       | Gate                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1. Inventory            | Source/dependency counts; capability and interface map                                            | Every supported path has an owner and parity test                                               |
| 2. Baseline             | Pinned toolchains, raw repeated measurements, environment metadata                                | Production Rust code; identical inputs; correctness checked before timing                       |
| 3. Protocol             | Message codec/ID, Merkle accumulator/proofs, checkpoint hashes, signing, metadata codecs          | Rust/Solidity vectors and randomized differential tests                                         |
| 4. Runtime              | Bounded state machines, injected clock/randomness/I/O, recovery journal, scheduling               | Deterministic crash/retry/reorg simulation; explicit memory bounds                              |
| 5. Chain adapters       | EVM, Sealevel, Cosmos/CosmosNative, Aleo, Radix, Starknet, Tron                                   | Protocol-specific fixtures and local-node conformance                                           |
| 6. Agents               | Relayer metadata/gas policies/lander; validator consensus/signing; scraper transactional pipeline | Existing behavioral tests ported; restart/reorg tests; exact wire and persistence compatibility |
| 7. Operations           | Config/env/CLI, metrics/admin endpoints, storage/cloud/KMS, packaging                             | Existing infra config accepted; API/schema snapshots; migration and rollback exercise           |
| 8. Shadow and benchmark | Same recorded traces and local chains; read-only mainnet shadow                                   | Equivalent outputs; no skipped events; CPU/RSS/RPC/build/size measurements                      |
| 9. Review and draft PR  | Independent reviews, reproducible tables and raw artifacts                                        | Failures and missing parity remain explicit; no speedup claim without equivalent work           |

## Architecture

Use Zig 0.15.2, pinned for reproducibility. Build with runtime safety enabled for
acceptance measurements; report other modes separately. Start with the standard
library only. Evaluate necessary dependencies explicitly; zero dependencies was
not specified as a requirement, and replacing vetted crypto/storage with an
unverified implementation is not a valid optimization.

Keep protocol types independent of sockets, storage, clock, and signing backends.
Use deterministic event transitions with bounded state and explicit effects.
Production I/O and the simulator drive the same transitions. Fault injection must
exercise lost/duplicate/reordered responses, timeouts, exhausted allocations,
crash boundaries, partial writes, reorgs, nonce gaps, and stale RPC votes.

Durability precedes external effects. A timeout after submission is ambiguous:
recover/check inclusion before resubmitting. A validator never signs a checkpoint
that disagrees with authenticated finalized local history. Failed RPC endpoints
retain their slots in the configured vote denominator. Confirmed scraper history
cannot be rewound; provisional history can.

## Benchmark contract

- Record commit, dirty diff identity, compiler, flags, host/OS/CPU, concurrency,
  input digest, repetitions, timer, and raw samples.
- Validate exact outputs before measuring; make timing results observable so
  compilers cannot eliminate the workload.
- Separate owned and borrowed parsing, protocol kernels, runtime simulation,
  local-chain end-to-end, and live read-only shadow measurements.
- Report median, min/max, dispersion, operations, CPU time, peak RSS, binary size,
  and build timing where meaningful. Distinguish warm-cache, cold project cache,
  and dependency-fetch-inclusive builds.
- Do not compare a full Rust agent build with a Zig kernel build as a language
  speedup. Do not extrapolate protocol microbenchmarks to agent throughput.
- Preserve regressions alongside improvements in the final table.

## Completion

Completion means the capability matrix is green, not that the executables build.
Pending capabilities and blocked measurements are listed in the status document
and draft PR. Production rollout is a separate decision after full parity,
independent security review, and an observed shadow window.

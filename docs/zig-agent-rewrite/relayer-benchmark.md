# Whole-relayer Rust/Zig benchmark harness

`zig/bench/relayer.py` compares the actual production Rust relayer with the native Zig daemon on disposable Anvil chains and real repository Mailbox, IGP, recipient, Null ISM, message-ID multisig, and Merkle-root multisig contracts. Public fixture key `0x11…11` is the only signing key. No production endpoint, credential, or database is read.

This is a harness, not a completed performance result. Root must declare both relayer binaries green before an actual smoke run. Final comparison requires at least five balanced pairs, final binary pins, a Root-authorized quiet window, and provenance for baseline `c520224`.

## Commands

Validate Python/harness arguments and write a non-passing plan without launching daemons:

```sh
python3 zig/bench/relayer.py smoke --dry-run \
  --output zig/bench/results/whole-relayer-smoke

# Compile the real Solidity fixture only; still no daemon launch.
python3 zig/bench/relayer.py smoke --compile-only \
  --output zig/bench/results/whole-relayer-contract-smoke
```

After Root declares the binaries green, run one Rust and one Zig smoke with checked provenance:

```sh
python3 zig/bench/relayer.py smoke --execute \
  --baseline-provenance /path/to/provenance.json \
  --output zig/bench/results/whole-relayer-smoke-actual
```

Final Root-authorized paired run:

```sh
python3 zig/bench/relayer.py paired --execute \
  --samples 5 --catchup 32 --steady 8 \
  --baseline-provenance /path/to/provenance.json \
  --quiet-host \
  --output zig/bench/results/whole-relayer-final
```

Provenance JSON must contain `baseline: "c520224"`, SHA-256 values for all four role binaries (`rust`, `zig`, `rust_validator`, `zig_validator`), and `oracle_sha256`, plus compiler/source revision details. The oracle value and actual binary must both equal the accepted immutable digest below. The harness checks role digests against pinned binary copies; timestamps and current source do not establish binary provenance. Existing output manifests are never overwritten.

## Measured workload and invariants

- Fresh chains and databases per attempt, identical configuration and trace. Rust receives `CONFIG_FILES`; Zig receives `HYPERLANE_ZIG_DEFAULTS`. Environments otherwise contain only Zig's explicit native curl path.
- One common pinned Rust c520224 checkpoint producer stays live through fresh delivery, confirmation and restart, with CPU/RPC excluded from relayer measurements. Backlog defaults to 32 messages; eight fresh messages arrive on an independent fixed schedule. Smoke uses four plus three.
- D1 and D2 run on independent Anvil processes with separate nonce spaces, while public key11 remains the only fixture key. Real `test1→test2` and `test1→test3` destination lanes are deployed. Accepted/retired fault request events must prove in-flight overlap for either healthy-progress boolean; no boolean is synthesized from a flag change. Fresh D2 work is scheduled inside the predeclared three-second hold, and origin `eth_getLogs` timestamps provide separate indexing evidence.
- The trace covers indexing, metadata, signing, broadcast, finality, actual gas expenditure, bounded three-second same-destination and different-destination receipt stalls with actual healthy-progress booleans, restart with no new signer nonce or expenditure, and SIGTERM/SIGINT. Progress is reported per implementation without requiring equal stall outcomes.
- Initial settlement requires all submitter/building/inclusion/finality queue metrics to be zero and `hyperlane_messages_processed_count` across test2/test3 to equal the full expected dataset in the same live scrape. Transient zero queues with an incomplete processed count are not retirement. Every live sample bounds the processed counter by the number of expected IDs whose individual first inclusion is at least 600 seconds old. This common cumulative bound rejects excess early retirements but cannot identify which ID retired when another ID is already eligible. Final paired runs use this same metrics-only polling for both implementations: `cumulative_600s_bound=true` and `per_id_active_presence_guard=false` for both. Zig smoke diagnostics additionally read both actual destination operation lists and require every ineligible ID to remain active; only that callback-enabled profile records `per_id_active_presence_guard=true`. Smoke CPU/RSS includes the extra admin work and is not a performance comparison. Rust has no equivalent active-ID guard: its `/list_operations` exposes prepare queues only, not confirm actors. Separate unmeasured native functional runs establish per-ID acceptance on the exact binary used for paired timings. The first early subset or complete sample raises immediately; a later zero sample at 601 seconds cannot mask it. The lower bound is the latest first eligible observation needed for full expected-ID coverage: only the first receipt response per chain/hash is retained, with successful status and an actual deployed-Mailbox `ProcessId` log; duplicate polls and unrelated transactions are excluded. A 50 ms observation tolerance is allowed, and post-shutdown timestamps are not retirement evidence. Idle restart instead requires positive current-process Source contract-sync evidence: `hyperlane_contract_sync_liveness{data_type="dispatched_messages"}` must be at least the new process’s Unix start and then increase, with positive `hyperlane_contract_sync_block_height`, zero new physical attempts, unchanged accepted nonces and unchanged stopped-DB state. Idle queue families are explicitly `null/uninstantiated`, never zero. Production Rust DB processed/expenditure evidence is read only after orderly shutdown; no writable oracle runs against a live daemon. No fixed sleep substitutes for settlement. The bounded evidence wait defaults to 660 seconds rather than incorrectly timing out at 90 seconds.
- `maxBatchSize` is identical. Each Zig message must prove `floor(actual_receipt_gas × own_sealed_estimate / sum_member_estimates)` and `allocated_gas × actual_price`, with per-ID receipt `ProcessId` attribution and explicit rounding dust. Aggregate-only or positive-underspend evidence is insufficient. Duplicate raw attempts, replacement transactions, unmined attempts, physical attempts, and accepted nonces per actual chain are separate. The `none` gas policy has no subsidy-budget assertion.
- One `relayer-probe-all PATH ORIGIN_DOMAIN ORIGIN_NAME COUNT DESTINATIONS_JSON` call scans all origin nonces once, returns actual destinations and mapping namespace provenance, and distinguishes absent aggregate records from recorded zero. Harness asserts exact nonce/message-ID/destination coverage. This workload dispatches canonical Mailbox messages only; a public receipt sidecar cannot substitute for a canonical producer row. Canonical receipt nonces use `eth_getTransactionByHash` with hash/block/signer identity checks, signed-raw hash verification, and canonical header height/hash binding.
- Same-destination false remains a documented serial-owner tradeoff. D2 and origin independence require actual in-window overlap, otherwise they are explicit acceptance gaps and paired `passed` cannot become true. Physical accepted/retired fault events are mandatory.
- Effective cadence is `--steady-interval-ms` (default 500 ms) and is serialized separately from configuration. Latest stopped-DB evidence is always re-probed independently after restart failure, archived as `latest-rust-probe.json`, and the failed DB is copied before temporary cleanup.
- Immutable Rust Lander has a known accounting gap: it processes messages without writing the expenditure aggregate. That is reported as `accounting_parity=false` with per-ID successful Mailbox `ProcessId` receipt attribution and actual receipt costs retained, without inventing sealed links or estimates. It is not zero real fees or semantic equivalence. Zig must still prove exact receipt↔DB cost equality with an actual expenditure record for every ID, including floor-allocation zero.
- Direct on-chain delivery, confirmation hold and processed retirement have separate timestamps and physical/logical RPC deltas. Whole-daemon CPU explicitly includes the 600-second hold and is never presented as delivery-only throughput.
- Physical RPC methods are counted per endpoint and startup/catchup/fresh/restart phase, including retries. Fixture/deployment/direct-validator RPCs remain separate. Metrics GET/HEAD and HELP inventories are retained.
- `wait4` records user/system CPU, peak RSS, wall time and shutdown. Thread snapshots, readiness, catchup throughput, fresh p50/p95/p99, and physical signed/broadcast counts are retained.
- Binary copies, source inventory, compiler/host inventories before and after, raw per-attempt logs, and unmodified failure artifacts are retained. Failed cleanup additionally snapshots every proxy counter and actual process usage; public configs, checkpoints, contract hashes, event timing, fault events and stopped-DB DTOs survive temporary-directory cleanup. Historical log/JSON inputs are tracked as deterministic `.json.gz`/`.log.gz` members with `packed-historical-artifacts.json`; exact raw recovery mirrors are ignored locally. Fresh-checkout readers must open the gzip member or restore the exact raw input with `python3 zig/tools/fixture_pack.py unpack <artifact.gz>` before using a default raw-path consumer.

## Current handoff gate

No daemon, build or timing run is authorized from the current harness-only edits. The authorized future oracle is `zig/bench/results/disk-preparation-20261106/rocks-helper-functional/ziggy-rocks-oracle` (SHA chunks `8e295002b44b4248d00d6627aaa47a21` + `2315f6f837f3a2d652f2e7f6ada69fd9`), with sealed estimates/private-stage evidence. Fresh immutable Zig/validator role binaries and provenance are still required, including production 600-second confirmation and current-process origin metrics. Old-pin Zig is not an equivalent profile. Final paired timing still requires Root quiet-window and final-binary authorization.

Current static validation: `PYTHONDONTWRITEBYTECODE=1 python3 zig/bench/relayer_test.py` passed26/26; the prepared release suite passed17/17; shared contract tests passed21/21; WS readiness contracts passed3/3. All five harness Python files passed `compile(...)`, and `git diff --check` passed. Harness SHA-256 chunks are `141db6c7622172c0bd7f0008f33c0e0f` + `681140c098162b1a329207c40bbc1e61`. The on-disk oracle matches the accepted digest. These checks launched no role, daemon, Anvil process, oracle executable, build or benchmark timer and do not establish a paired pass.

## Interpretation gates

`passed: true` is emitted only for at least five completed pairs with all correctness/oracle checks. Smoke always remains non-final. No broad outperform claim is allowed without the final paired results. Zig WAL fsync choices, Rust production durability, telemetry/runtime differences, host contention, and batch shape remain explicit limitations. EVM/local signing/local checkpoint storage results do not cover other VMs, cloud/KMS, production networks, or every runtime feature.

`--quiet-host` is used only when Root authorizes that window. It fails if Cargo, rustc, Zig, Clang, solc, or pnpm work is active. Unrelated user workloads are never stopped.

Independent harness closure added native per-ID active presence after a pure
counterexample: B included at20s could retire at610s while A included at0s
retired at621s, producing legal cumulative counts at both samples. The Zig diagnostic guard
rejects B's disappearance immediately. Both measured paired profiles retain the
same cumulative bound and explicitly report no per-ID presence capability. This
avoids imposing roughly24,000 extra admin requests on only the native process
during a600-second hold. Equal extra request counts would still be unequal work:
Rust's prepare queue can be empty while native serializes every confirming actor.
Native per-ID proof instead comes from separate functional acceptance on the exact
pinned binary.
Production Rust's600s policy remains independently established by
`pending_message.rs` (`CONFIRM_DELAY`, prepare's already-delivered branch and
confirm's readiness check) and `message_processor.rs` (`confirm_op`). No live DB
oracle or production-code change was added for this distinction.

## Exact-binary functional prerequisites for final timing

`paired --execute` requires three passing JSON results before launching any
role: `--relayer-process-proof PATH`, `--relayer-stream-proof PATH`, and
`--public-relay-proof PATH`. They cover three ISMs, exactly four batch targets,
pre-enqueue crash/recovery, WSS restart, and both normal-indexed/public-sidecar
modes. Every artifact must name the exact pinned native relayer SHA; recorded
per-ID600s inclusions and first live completion must pass the gate. Isolated
3-ISM/batch/crash/public cases require zero historical allowance; WSS retains its
explicit older-ID allowance and tracked-ID bounds. Missing, failed, old5s, or
different-binary proofs stop execution. Accepted artifact paths and content hashes
are linked under `native_functional_prerequisites`; dry-run/smoke manifests never
claim the prerequisite is verified. These three proof arguments also accept
lossless `.json.gz` artifacts directly. The manifest records both the actual
file hash and the decoded JSON hash; compression changes no acceptance checks.
No old-pin result is a substitute for final-pin functional acceptance.

These prerequisites are currently unverified until fresh passing artifacts are
provided. The immutable Rust600s policy is independently checked from Source;
no writable live-DB oracle, production behavior change or extra operation-list
polling is introduced into final CPU/RSS measurements.

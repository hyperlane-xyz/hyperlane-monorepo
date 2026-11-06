# Native submit-queue backpressure

The native preparation threshold implementation is stable and its focused correctness checks pass49/49, zero skips. Global Source acceptance remains closed. This slice implements preparation queue pressure; it does not claim Starknet grouped transaction submission, which is the next separate integration.

## Source behavior implemented

Rust ChainConf::operation_submission_config supports Ethereum, Cosmos Wasm, Sealevel and Starknet. Ethereum keeps its existing Lander constructor forwarding. The new native gate applies ONLY to Cosmos Wasm, Sealevel and Starknet; Cosmos Native, Radix, Aleo and Tron ignore the parsed option as Source does.

Root snapshots the configured queue threshold before a preparation batch. ReadyToSubmit actors count until popped for submission. Signed/popped work and confirmations do not count, and remain runnable with a zero threshold. Public receipt admission and administrative control remain available. Zero holds new preparation before recipient/metadata/origin-sender work; it changes neither durable retry count nor operation status and schedules the held actor after150ms. Owner scheduling preserves that deadline rather than rounding it up to a100ms poll boundary.

Business state is separate from metrics. A newly loaded/restored actor hydrates queue/phase state from the actual NativeOperation journal once; live actor transitions refresh that cache even when telemetry is disabled or failing. Retry/reprocess invalidates it. Rust-compatible Ready/Confirm phase restoration also bypasses the fresh preparation gate.

An admitted preparation batch retains per-member admission tokens across PendingReadIo. A later owner poll cannot admit a second batch while that first batch is incomplete. The original batch may exceed the threshold when its preparations complete, matching Source's once-before-batch check rather than enforcing a per-message reservation. Ready actors are marked popped before quote/sign RPCs; their pending continuations remain outside queue counts. Normal completion, retry, control reset and noncooperative errors release the appropriate admission state. Pending I/O retains it.

## Verification

Exact command and raw output are adjacent; counts include import-root tests.

| Check | Result | Evidence |
| --- | --- | --- |
| Native Root/Driver targeted suite, including all96 core OOM offsets and Registry-pressure cleanup | 49/49 passed, zero skips | native-tests.log |
| Typed Cosmos Wasm, Sealevel and Starknet zero limits; no client/private preparation access, no retry/status change; public receipt admission and cancellation | passed | Root native submit zero case |
| Real RocksDB restored-ready queue; metrics disabled; manual reprocess frees queue and restores fresh generation | passed | Root native submit cap case |
| Once-per-batch threshold, positive overshoot and signed/Confirm exclusions | passed | Root native submit batch threshold case |
| Actual SVM pending read during admitted preparation, no new batch admitted across continuation | passed | Root native submit admitted preparation batch case |
| Actual SVM pending read after popping a Ready actor; fresh work can enter; manual control resets popped state | passed | Root native submit popped ready IO case |
| Actual native driver prepared/sign/restart/broadcast lifecycle while new preparation held; full tagged identity preserved | passed | Native destination driver orders case |
| Actual600s external-delivery confirmation/recheck while new preparation held | passed | source600s Native driver case |
| Supported/ignored protocol map and Ready/Confirm/signed phase projection | passed | native preparation limit / submission phase cases |
| Actual validator and scraper service_main ReleaseSafe, -fno-emit-bin | compiled | validator-compile.log / scraper-compile.log |
| Actual relayer service_main, -fno-emit-bin | blocked by concurrent origin companion compile errors, owner notified | relayer-origin-in-progress*.log |
| zig fmt --check on owned five files | passed | manifest.json |

Two old native driver fixture omissions became reachable during this work: strict default-ISM classification requires a real additional getter response. The native script now supplies it, and the dynamic CCIP fixture recognizes defaultIsm(). Existing behavioral assertions were preserved. Failure cleanup now destroys the native Actor even when an early assertion fails; no expected outcome was weakened.

The first relayer compile saw origin_tasks optional-delay and inferred-error-return failures in the concurrently owned tx-ID companion integration. The follow-up compile after the optional-delay correction still reported origin_tasks:291 returnerr. Baseline owner has the exact logs; these are outside the owned cap write set. Parent must recompile the final merged roles after that owner releases its source.

Source hashes were captured before the accepted49-test run and verified unchanged afterward. Parent's tx_id_indexing_enabled Root forward was preserved. No metadata production files were edited, and there were no emitted role pins, benchmarks, containers, production keys, commits or pushes. Typed zero-gate fixtures use initialized public identities with deliberately absent chain clients so any private preparation would fail; the continuation fixtures execute actual injected SVM RPC and native durable lifecycle paths. This is component correctness evidence, not mainnet execution or full rewrite acceptance.

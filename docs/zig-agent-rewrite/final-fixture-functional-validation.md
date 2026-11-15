# Current fixture functional validation

The current fixture checks passed at `f7bdda8cf66a179a85e72c115c0f64cbea676fbb`. Their runtime production code and 38 measured build products remain at `8872c5e470f1a096f8cd32a3661d0d69c0a3aa0b`. The three-file fixture correction changes the exact-four batch preparation barrier and metadata replay-count test, with no production, SDK or benchmark source change.

| Gate                |                                   ReleaseSafe |             ReleaseFast | Scope                                       |
| ------------------- | --------------------------------------------: | ----------------------: | ------------------------------------------- |
| Default suite       |                          745 passed, no skips |    745 passed, no skips | Actual matching-mode measured Aleo workers  |
| Native DB aggregate |                       1,055 passed, 1 skipped | 1,055 passed, 1 skipped | RocksDB, SDK and native transport cases     |
| PostgreSQL          |            21 migrations, 11 functional cases |                       — | Actual PostgreSQL 16.15                     |
| RPC producers       |                                    410 passed |                       — | Provider, cloud and read paths              |
| Operator regex      |                                     56 passed |                       — | Actual regex bridge                         |
| WS/WSS              |                                     22 passed |                       — | Transport and wire cases                    |
| Socket owner        |                                      4 passed |                       — | Ownership, shutdown and allocation failures |
| Role build and help | Three roles built; three help commands passed |                       — | Separate generic correctness products       |

The native skip in each mode is `opt-in loopback prepares actual repo Solidity without delivery or nonce mutation`. Both default suites use the exact measured matching-mode workers and passed with zero skips. Their worker, library and parameter environment is pinned in the manifests.

## Three executions supply the Safe rollup

Five actual execution manifests contain 13 successful commands: Safe default, Safe native, nine Safe remainder checks, Fast default and Fast native. The [Safe eleven-check rollup](../../zig/bench/results/global-fixture-acceptance-20261106/safe-rollup/all-manifest.json.gz) combines three independent actual executions. It is not an additional execution, one continuous run or a timing result. Component starts, raw manifests, commands and log hashes remain preserved.

The independent review checks the exact component manifest bytes, flattened check objects and order, all eleven log hashes and exit codes, common source maps, runtime environment and emitted products. The final gate uses ordinary worker-byte identity credit: `worker_checks` is empty because the primary current default checks already use the measured workers. The earlier preparation descriptor is preserved separately as superseded; its duplicate worker coverage does not replace the final descriptor.

The role-build and help checks use re-emitted generic correctness executables. That build omits `-Dcpu=native`; it does not prove exact-byte execution of the separate [timed native-CPU role products](final-lifetime-build-matrix.md).

## Separate runtime and fixture provenance

All five manifests and the derived Safe rollup agree on 660 physical source/test inputs, before and after checks and at archive readback. Of these, 658 match blobs in fixture commit `f7bdda8c`. Two ignored vendored Aleo dependency files are bound by physical hashes:

- `zig/src/aleo/native-vm/vendor/aleo-std-storage-1.0.3/Cargo.toml`
- `zig/src/aleo/native-vm/vendor/aleo-std-storage-1.0.3/src/lib.rs`

The [current source record](../../zig/bench/results/global-fixture-acceptance-20261106/source/current660pins.json.gz) preserves that distinction. The archive rechecks all 38 measured products, seven static native archives, actual library/worker inputs and three correctness-build roles. Runtime build timings retain their original `8872c5e4` provenance and complete historical fingerprint; the changed fixture fingerprint is separate.

The historical V5 plan is preserved byte for byte as the source of the unchanged product descriptors. Its obsolete 760-input fixture closure and failed process proof are not credited as current V6 coverage. The [batch barrier report](relayer-batch-preparation-barrier.md) records the normal hooked fixture commit and the diagnostic exact-four result. That short diagnostic stopped before the 600-second hold and is not full process acceptance.

## Archive and proof boundary

The [manifest](../../zig/bench/results/global-fixture-acceptance-20261106/manifest.json) binds 31 deterministic gzip payloads: five raw actual manifests, all 13 logs, the derived rollup, creation scripts, independent review/results, source and artifact descriptors, normal fixture hooks and both gate descriptors. Every packed and decoded hash/length was verified, and originals remain untouched. The [verification](../../zig/bench/results/global-fixture-acceptance-20261106/verification.json) records 601,291 compressed bytes and 1,993,362 decoded bytes. No runtime binaries, databases or cache trees were copied.

The [final identity gate](../../zig/bench/results/global-fixture-acceptance-20261106/gate/final-identity.json.gz), SHA beginning `85ea9652` and ending `59cbb276`, prepares eligibility for V6 generation. Separate dual-provenance attestation and six fresh strict process proofs are still required before paired timing. This archive claims no completed V6 process proof, image acceptance or paired performance result.

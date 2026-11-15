# Lifetime-fixed functional validation

The broad source gates and the supplemental checks with the newly built Aleo workers passed at production source `8872c5e470f1a096f8cd32a3661d0d69c0a3aa0b`. All 15 commands across five gate manifests exited successfully. These are correctness checks, separate from the [timed build matrix](final-lifetime-build-matrix.md) and the subsequent process proofs.

| Gate                       |                                   ReleaseSafe |             ReleaseFast | Scope                                               |
| -------------------------- | --------------------------------------------: | ----------------------: | --------------------------------------------------- |
| Original default suite     |                                    745 passed |              745 passed | Same selected source; prior matching-mode workers   |
| Native DB aggregate        |                       1,055 passed, 1 skipped | 1,055 passed, 1 skipped | Actual RocksDB, SDKs and native transports          |
| Supplemental default suite |                          745 passed, no skips |    745 passed, no skips | Exact new matching-mode worker from the timed build |
| PostgreSQL                 |            21 migrations, 11 functional cases |                       — | Actual PostgreSQL 16.15                             |
| RPC producers              |                                    410 passed |                       — | Provider, cloud and read-path regressions           |
| Operator regex             |                                     56 passed |                       — | Actual regex bridge and dependent cases             |
| WS/WSS                     |                                     22 passed |                       — | Transport and wire-format cases                     |
| Socket owner               |                                      4 passed |                       — | Ownership, shutdown and allocation failures         |
| Role build and help        | Three roles built; three help commands passed |                       — | Separate correctness-build products                 |

The native aggregate's one skip in each mode is named `opt-in loopback prepares actual repo Solidity without delivery or nonce mutation`. It is not represented as a passed test or hidden SDK coverage. The supplemental default suites had no skips.

## Exact workers and runtime inputs

Both worker hashes changed in the new build matrix. The supplemental suites use the actual new `ReleaseSafe` and `ReleaseFast` workers, respectively, rather than crediting the older workers by source similarity. Their manifests bind the worker bytes, reused SDK libraries, libcrypto, parameter environment and all selected source inputs.

Root reviewed the actual authorization/proving wire, local proof/fee binding and OS sandbox tests: they require the worker, SDK and parameter environment and would skip without those inputs. The supplemental suites passed all 745 tests with zero skips. The [Root gate descriptor](../../zig/bench/results/global-lifetime-acceptance-20261106/preparation/root-final-functional-gate.json.gz) preserves that explicit coverage review.

The Safe role build/help checks emitted three separate executables. That command does not select `-Dcpu=native`, and its bytes differ from the timed native-CPU products:

| Role      | Correctness-build bytes | Timed Safe bytes |
| --------- | ----------------------: | ---------------: |
| Relayer   |              15,002,312 |       15,004,648 |
| Validator |              13,620,936 |       13,623,240 |
| Scraper   |               3,247,224 |        3,247,352 |

The help checks therefore validate the re-emitted correctness products. They are not exact-byte execution evidence for the timed role products. The later process proofs must use the timed products named in their plan.

## Source and artifact closure

All five manifests agree on 659 selected physical source/test inputs, before and after their checks and at archive readback. Of those, 657 match blobs in the normal hooked commit. Two ignored vendored Aleo dependency files are pinned by physical bytes rather than invented committed blobs:

- `zig/src/aleo/native-vm/vendor/aleo-std-storage-1.0.3/Cargo.toml`
- `zig/src/aleo/native-vm/vendor/aleo-std-storage-1.0.3/src/lib.rs`

Their exact hashes remain in the source maps and V5 plan. The [commit-scope record](../../zig/bench/results/global-lifetime-acceptance-20261106/source/commit-scope.json.gz) preserves the distinction. The physical pins for these ignored dependencies are retained without claiming committed blobs. No gate inputs were rewritten.

The archive also rechecks the seven static native archives, the actual library/worker environment, three correctness-build roles, 38 matrix products and all 760 common V5 input descriptors. It preserves the normal commit/hook log, runner, commands, five raw manifests and all 15 raw logs as deterministic lossless gzip files. Every decoded and packed hash/length was verified; original files remain untouched. No binaries, cache trees, databases or active process output were copied.

See the [manifest](../../zig/bench/results/global-lifetime-acceptance-20261106/manifest.json) and [verification](../../zig/bench/results/global-lifetime-acceptance-20261106/verification.json). The [lifetime fix report](lander-batch-lifetime-fix.md) separately records the use-after-free regression, exact owner replacement, allocation-failure controls and independent review. The earlier [admission report](canonical-admission-order.md) preserves its own source-qualified evidence.

## Process-proof preparation

The exact V5 plan is [preserved byte for byte](../../zig/bench/results/global-lifetime-acceptance-20261106/preparation/v5-plan-byte-exact.json.gz), with SHA beginning `bec7155b` and ending `6a556c9d`. Its 760 common inputs include the immutable launcher, final command metadata, gate manifests/logs, reused dependencies and new products. Descriptor kinds deduplicate paths; the 647 `final-selected-source` entries inside that list do not replace the full 659-input gate maps.

The plan preserves 22 original products and eight failed V4/e0 products, together with eight new products. Its prior e0 products remain historical evidence, not full process acceptance. The Root-approved descriptor grants eligibility to start six serial process proofs. It does not declare them passed. The plan preserves the 600-second confirmation hold, 30-second finality grace and stop-on-first-failure rule. Its generator/review snapshots are preparation evidence; their earlier statements that no plan existed describe their own capture time.

At this archive's capture, V5 index 0 was active and its initial confirmation hold remained pending. Active or partial outputs are intentionally excluded. This report claims neither completed process proofs, new-image acceptance nor paired runtime performance acceptance.

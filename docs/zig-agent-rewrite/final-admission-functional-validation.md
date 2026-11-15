# Admission-fixed functional validation

The broad source gates and the supplemental checks with the newly built Aleo workers passed at production source `e0b95ebf0189e3cc75c3ae1e48a2d9581006e8d0`. All 15 commands across five gate manifests exited successfully. These are correctness checks, separate from the [timed build matrix](final-admission-build-matrix.md) and the subsequent process proofs.

| Gate                       |                                   ReleaseSafe |             ReleaseFast | Scope                                               |
| -------------------------- | --------------------------------------------: | ----------------------: | --------------------------------------------------- |
| Original default suite     |                                    745 passed |              745 passed | Same selected source; prior matching-mode workers   |
| Native DB aggregate        |                       1,052 passed, 1 skipped | 1,052 passed, 1 skipped | Actual RocksDB, SDKs and native transports          |
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

Root reviewed the actual authorization/proving wire, local proof/fee binding and OS sandbox tests: they require the worker, SDK and parameter environment and would skip without those inputs. The supplemental suites passed all 745 tests with zero skips. The [Root gate descriptor](../../zig/bench/results/global-admission-acceptance-20261106/preparation/root-final-functional-gate.json.gz) preserves that explicit coverage review.

The Safe role build/help checks emitted three separate executables. That command does not select `-Dcpu=native`, and its bytes differ from the timed native-CPU products:

| Role      | Correctness-build bytes | Timed Safe bytes |
| --------- | ----------------------: | ---------------: |
| Relayer   |              15,002,312 |       15,004,440 |
| Validator |              13,620,936 |       13,623,032 |
| Scraper   |               3,247,224 |        3,247,336 |

The help checks therefore validate the re-emitted correctness products. They are not exact-byte execution evidence for the timed role products. The later process proofs must use the timed products named in their plan.

## Source and artifact closure

All five manifests agree on 658 selected physical source/test inputs, before and after their checks and at archive readback. Of those, 656 match blobs in the normal hooked commit. Two ignored vendored Aleo dependency files are pinned by physical bytes rather than invented committed blobs:

- `zig/src/aleo/native-vm/vendor/aleo-std-storage-1.0.3/Cargo.toml`
- `zig/src/aleo/native-vm/vendor/aleo-std-storage-1.0.3/src/lib.rs`

Their exact hashes remain in the source maps and V4 plan. The [commit-scope record](../../zig/bench/results/global-admission-acceptance-20261106/source/commit-scope.json.gz) preserves the distinction. An initial archive-only blanket commit check rejected the first ignored file; that diagnostic is retained. It was not a production or test failure, and no gate inputs were rewritten.

The archive also rechecks the seven static native archives, the actual library/worker environment, three correctness-build roles, 30 matrix products and all 750 common V4 input descriptors. It preserves the normal commit/hook log, runner, commands, five raw manifests and all 15 raw logs as deterministic lossless gzip files. Every decoded and packed hash/length was verified; original files remain untouched. No binaries, cache trees, databases or active process output were copied.

See the [manifest](../../zig/bench/results/global-admission-acceptance-20261106/manifest.json) and [verification](../../zig/bench/results/global-admission-acceptance-20261106/verification.json). The [canonical admission report](canonical-admission-order.md) separately records the regression, persistence capabilities, signed recovery boundaries and focused security review.

## Process-proof preparation

The exact V4 plan is [preserved byte for byte](../../zig/bench/results/global-admission-acceptance-20261106/preparation/v4-plan-byte-exact.json.gz), with SHA beginning `30edaf5a` and ending `24fe7834`. Its 750 common inputs include the immutable launcher, final command metadata, gate manifests/logs, reused dependencies and new products. Descriptor kinds deduplicate paths; the 646 `final-selected-source` entries inside that list do not replace the full 658-input gate maps.

The Root-approved descriptor grants eligibility to start six serial process proofs. It does not declare them passed. The plan preserves the 600-second confirmation hold, 30-second finality grace and stop-on-first-failure rule. Its generator/review snapshots are preparation evidence; their earlier statements that no plan existed describe their own capture time.

At this archive's capture, V4 index 0 was active and its initial confirmation hold remained pending. Active or partial outputs are intentionally excluded. This report claims neither completed process proofs, new-image acceptance nor paired runtime performance acceptance.

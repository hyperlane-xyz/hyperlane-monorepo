# Final fixture provenance

V6 uses the measured production runtime at `8872c5e470f1a096f8cd32a3661d0d69c0a3aa0b` with correctness fixtures at `f7bdda8cf66a179a85e72c115c0f64cbea676fbb`. The runtime binaries, build measurements, SDKs and Rust comparators are preserved. A separate reviewed attestation binds the exact fixture delta; it does not relabel the older build fingerprint as a build of the fixture commit.

## Exact three-file delta

| Path                                                | Change                                                                                                          | Runtime effect                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `zig/integration/relayer_process.py`                | Hold submission until four real sealed payloads are prepared, then restart the same DB with submission released | Functional fixture only; exact-four, fee and 600-second checks retained |
| `zig/integration/relayer_batch_preparation_test.py` | Added pure controls for the preparation barrier                                                                 | Test only                                                               |
| `zig/src/metadata_parallel_delegated_tests.zig`     | Require all four children in the replay-count fixture; retain the exact five-visit bound                        | Test import only; no production executor change                         |

The normal fixture commit and hooks are [preserved](../../zig/bench/results/final-functional-v6-preflight/source/fixture-normal-hooks.log.gz). The [barrier report](relayer-batch-preparation-barrier.md) records the original greedy `[2,1,1]` batch diagnosis, actual prepared-four diagnostic and unchanged strict allocation guards. The metadata correction addresses a separate test assumption: a quorum of two could legitimately complete before every child entered, making the old exact-five visit expectation nondeterministic.

The finalizer compares both complete Git trees. Outside documentation, result artifacts and these exact three fixture paths, all 5,575 tracked path/mode/type/blob entries match a pinned closure. It validates the sole metadata test import, all changed Git blobs and current physical bytes, 29 native-FFI source pins and all 38 runtime products. Of the current 660 physical selected inputs, 658 match fixture-commit blobs; the two ignored Aleo vendor files remain bound to their original physical hashes.

## Separate approval and fingerprints

The [unapproved candidate](../../zig/bench/results/final-functional-v6-preflight/provenance/candidate-unapproved.json.gz), SHA beginning `57d7fff3`, remains intact with `root_approved: false`. Root created a separate [approved final attestation](../../zig/bench/results/final-functional-v6-preflight/provenance/approved-final.json.gz), SHA beginning `a6b29563` and ending `c2be0777f`. The generator reruns the pinned read-only audit and compares every authoritative field with that final attestation.

The original measured runtime fingerprint is `06b4c65bbc76872029e853a21d7326e597ae73bf1a7819ec2ddf70f303aa314e`. The current complete fixture fingerprint is separate and must differ. Historical build logs, CPU/RSS measurements and timings keep their original runtime provenance. This test-only correction is not a new cold build or dependency-inclusive trial. See the [build matrix](final-lifetime-build-matrix.md) for its qualified reused-dependency comparison.

Current correctness gates are [recorded separately](final-fixture-functional-validation.md). Safe eleven-check coverage combines three actual executions, explicitly; it is not a single-run timing. Their exact component manifests, flattened checks, environment, worker/runtime dependencies and source maps are pinned by the V6 generator. Matching-mode measured workers receive ordinary exact-byte identity credit.

## V6 preparation

The [byte-exact V6 plan](../../zig/bench/results/final-functional-v6-preflight/plan/launch-plan.json.gz) has SHA `ebc9be17ec459c9ec0aad54a5b2f88184a169f82cf5efd85c41aa0f318621bb0`. It pins 764 deduplicated common inputs, the current 660-source closure and 38 runtime products: 22 original products, eight historical failed-e0 products and eight current runtime products. The historical products remain evidence, not completed process acceptance.

The six ordered proofs are `ReleaseSafe` process, stream and public relay, followed by the same three `ReleaseFast` proofs. Each uses exact measured role/worker bytes and original SDK/native dependencies through the immutable launcher. The 600-second confirmation hold, 30-second grace, strict per-ID proof checks, serial lock and stop-on-first-failure rule are unchanged. The original V5 plan and earlier paired V4 plan are archived as historical descriptors, without crediting obsolete fixture inputs or failed outputs as fresh coverage.

Independent review accepted the finalizer and generator. Three wrong/reversed-commit controls reject before filesystem audit, and 17 generator checks cover actual component sealing, altered modes/maps/dependencies/timestamps/checks, duplicate or escaping paths, hashes and command metadata preservation. The owner separately passed 17 pure controls. The command-metadata update preserves Rust paths, sample counts, corpus and intervals; only proof/output paths and explicit dual provenance change.

The [preflight archive](../../zig/bench/results/final-functional-v6-preflight/manifest.json) contains 34 deterministic gzip payloads, including scripts, contracts, diffs, candidate and final attestations, gate, plan, command metadata, reviews and controls. Every decoded and packed hash/length was verified; all 764 pinned input bytes were rehashed and originals remain unchanged. The [verification](../../zig/bench/results/final-functional-v6-preflight/verification.json) records 443,151 compressed bytes and 2,302,120 decoded bytes. No binaries, databases or cache trees were copied.

V6 index 0 had started when this preparation archive was sealed. Active outputs are excluded. Neither the plan, attestation nor this report claims a passed V6 proof, image acceptance or paired performance result. All six full proofs and a quiet host remain prerequisites for any paired timing.

## Paired preparation remains blocked

A separate [paired preflight archive](../../zig/bench/results/final-paired-v6-preflight/manifest.json) preserves the new paired V5 plan, its generator/diff, immutable wrapper and independent review. This paired-plan version consumes functional plan V6; the two version numbers describe separate preparation artifacts. Plan SHA `0e93291f78d8c15b70582cfc35a1d57ed85d37b50f8083b8479d904f3c941979` pins 774 common inputs and 38 runtime products.

All ten ordered scenarios remain: four validator, two scraper, two singleton relayer and two genuine batch-cap4 relayer scenarios, each five Rust/Zig pairs. Full command comparison against the previous plan permits only relayer proof, provenance and fresh output paths. Rust environment, corpus, intervals, sampler/timer behavior and original singleton workload are preserved. Batch-cap4 samples must still prove an actual canonical multi-member batch in each implementation.

All six V6 proof gzip files were missing at this preparation readback. The unchanged strict acceptance helper rejected that state before any benchmark module import or target execution. The plan explicitly records timing eligibility as false. The [paired verification](../../zig/bench/results/final-paired-v6-preflight/verification.json) binds eight lossless payloads totaling 110,159 compressed bytes, with all 774 common inputs rehashed. This is preparation evidence; no paired benchmark ran.

# Four-message preparation barrier

The functional fixture now waits for four actual sealed, pending payloads before allowing Lander to build their transaction. The production builder remains greedy: `maxBatchSize=4` is a maximum, not a requirement to wait for four messages.

The [failed V5 archive](../../zig/bench/results/final-relayer-batch-membership-diagnostic/manifest.json) preserves the reason this synchronization was needed. Messages 5 and 8 finished preparation first and entered one two-call batch. Message 7 prepared about five seconds later, and message 6 about fifteen seconds later; each became a singleton. Both initial and batch 600-second retirement/readback stages completed, but the strict four-call allocation assertion failed. The complete proof remains failed.

## Fixture change

The batch stage starts the exact existing `8872c5e4` relayer with destination `maxSubmitQueueLength=0`. EVM preparation, sealing and enqueue continue, while Lander's queue check prevents new transaction construction and signing.

The fixture requires all four exact message IDs and decoded wires in admin state `ReadyToSubmit`, with `submitted=false`. It checks that no send request occurred and the account nonce did not change. After clean shutdown, the independent Rust reader must find four canonical sealed links, positive estimates, matching UUIDs, actual `ReadyToSubmit` destination payloads, no expenditure record and no processed marker.

Only the queue cap is removed before restarting the **same database**. The destination domain, chain ID, mailbox and signer, plus origin domain and Merkle hook, remain unchanged. Those fields bind the EVM operation context; the queue cap does not. The fixture later verifies that restart preserved every sealed UUID, estimate and member nonce.

The existing exact-four aggregate calls, message membership, canonical receipt, original prebroadcast estimates, weighted expenditure, 600-second retirement and crash/restart guards are unchanged. No production source, policy or paired benchmark behavior was modified.

## Evidence

| Check                                    | Result                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| New preparation controls                 | 16 passed                                                                                             |
| Existing estimate / early guard controls | 10 / 10 passed                                                                                        |
| Existing benchmark / static controls     | 28 / 21 passed                                                                                        |
| Independent controls                     | 42 passed, including six lifecycle failure cases                                                      |
| Original fixture AST                     | Identical after removing only explicit preparation additions and restoring the relocated config write |

An authorized short **actual** diagnostic used fresh Anvil contracts, four messages across all three ISM types, the unchanged Safe relayer/validator and immutable Rust reader. Under cap zero, it observed four sealed pending payloads, zero send requests and account nonce `1 → 1`. Preparation shutdown exited zero.

Releasing the cap on the same database produced one canonical `aggregate3` transaction with four exact calls, wires and `ProcessId` events. All four admin operations entered `Confirm.SubmittedBySelf`; UUIDs and estimates remained unchanged. Validator, preparation and released-role shutdowns all exited zero. The diagnostic stopped before the 600-second hold and deliberately records `passed=false, diagnostic_only=true`. It does not accept the full retirement or fee-allocation proof.

## Provenance

The [component manifest](../../zig/bench/results/relayer-batch-preparation-barrier/manifest.json) and [verification](../../zig/bench/results/relayer-batch-preparation-barrier/verification.json) preserve 23 deterministic lossless gzip payloads: before/current fixture source, pure commands/logs, patch, offline V5 decoding and the short diagnostic. The separate [independent receipt](../../zig/bench/results/relayer-batch-preparation-barrier/independent-receipt.json) adds eight verified review/test payloads without replacing the original component record.

All 38 runtime products and five runtime/build source pins still match `8872c5e470f1a096f8cd32a3661d0d69c0a3aa0b`. This is a fixture correction at a later correctness revision; it does not manufacture a new runtime build measurement. The previous V5 inputs remain byte-exact historical evidence. The separate [normal commit receipt](../../zig/bench/results/relayer-batch-preparation-barrier/commit-receipt.json) binds the unchanged barrier files to correctness commit `f7bdda8cf66a179a85e72c115c0f64cbea676fbb`. Its exact three-file delta also includes the independently reviewed metadata replay-count test correction. Production runtime `8872c5e4` and its measured products are unchanged; the original component records remain intact.

Independent review found no unresolved blocker. Full process proofs, final images and paired runtime performance remain separate gates; the short diagnostic is preparation evidence only.

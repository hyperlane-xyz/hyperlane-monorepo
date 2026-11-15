# Lander batch JSON lifetime

Batch simulation retained JSON children from a temporary arena after freeing that arena. The fix deep-copies the rebuilt fields into the transaction record's own arena before replacing either field.

The V4 Safe process proof exposed the bug in the `e0b95ebf` binary. Its initial three-message 600-second retirement, receipt verification and stopped Rust readback completed. The later batch role aborted while the fixture waited for four ready operations. The complete proof failed. The [failed-run archive](../../zig/bench/results/final-relayer-batch-lifetime-diagnostic/manifest.json) preserves the exact inputs, stack and partial progress; those successful substages do not count as full proof acceptance.

## Cause and fix

`Service.simulateBatch` built a temporary `records.OwnedJson`, copied its `payload_details` and `vm_specific_data` values into the surviving `JsonRecord`, then ran `rebuilt.deinit()`. A managed JSON map carries its allocator context as well as its backing buffers. Both pointed into the destroyed temporary owner.

`Service.submit` subsequently updated the transaction request. A map growth called through the dead allocator, matching the captured stack: `submit` → `ArrayHashMap.getOrPut` → `ArenaAllocator.alloc` at an invalid address. The problem affects both all-surviving batches and partial simulations reduced to one survivor.

The replacement serializes the rebuilt root and parses a complete copy into `record.parsed.arena.allocator()`. That arena is the record's stable heap owner. Only after the fallible copy succeeds does the code replace both existing fields through `getPtr`; it does not allocate a root-map insertion between replacements. The retained maps, arrays, keys and strings therefore outlive the reconciliation scratch arena.

The explicit `.allocate = .alloc_always` documents ownership. In the actual Zig 0.15.2 implementation, `std.json.Value.jsonParse` already forces token copies, so this flag does not fix a second borrowed-string bug. `parseFromValue(Value)` would return the original value and was not used as a clone.

Independent variant review found no other escaping `OwnedJson` subtree in the service, storage or record callers. Enqueue and build paths serialize while their owners and borrowed inputs remain alive. No storage parser, policy, confirmation timer or integration harness change was needed.

## Verification

| Check                          |             Result | Scope                                                                                                         |
| ------------------------------ | -----------------: | ------------------------------------------------------------------------------------------------------------- |
| Original production behavior   | 1 passed, 1 failed | Deterministic allocator-owner assertion after actual build and simulation return; no freed-buffer dereference |
| Final Lander root, ReleaseSafe |          82 passed | No skips, failures or leaks                                                                                   |
| Final Lander root, ReleaseFast |          82 passed | No skips, failures or leaks                                                                                   |
| Independent review             |           Accepted | Final three source hashes, results and logs verified; no reviewer builds                                      |

The new regressions cover both survivor counts. They destroy scratch storage, churn heap and stack memory, force 48 new nested map fields, then serialize and verify IDs. A clone allocation-failure sweep checks that neither field nor the durable row changes before success.

Actual public service ticks sign and persist a batch or its surviving singleton. The tests close and reopen RocksDB, then finalize the original attempt with the same raw bytes and nonce, no additional broadcast, and unchanged sealed payload gas/IDs. Existing zero-survivor terminal-drop assertions also pass in both full roots. The regressions are permanently reached through the existing `db_tests.zig` import of `lander/tests.zig`; the new wrapper is only a focused test entrypoint.

## Provenance

The [manifest](../../zig/bench/results/lander-batch-lifetime-fix/manifest.json) contains 27 lossless gzip payloads: before/final source, commands, results, logs, patch and independent review. [Verification](../../zig/bench/results/lander-batch-lifetime-fix/verification.json) checks every packed and decoded hash/length and the three current source pins. Intermediate focused runs remain identified as earlier snapshots; the final 82-test roots bind the complete frozen fix.

This archive was sealed while the fix was uncommitted against `e0b95ebf0189e3cc75c3ae1e48a2d9581006e8d0`. The separate [normal commit receipt](../../zig/bench/results/lander-batch-lifetime-fix/commit-receipt.json) now binds the unchanged three pins and exact patch to production commit `0aa1dc7c754137939fd0099c2b6c69f74a7a0404`. Its benchmark-only child `8872c5e470f1a096f8cd32a3661d0d69c0a3aa0b` preserves those pins and adds the reviewed batch workload witnesses. Both normal hook logs are retained; the original precommit manifest and verification remain unchanged. Broader source gates, fresh build products, images, full process proofs and performance results remain separate required evidence. The old `e0` products and measurements are retained as historical inputs, not acceptance of this fix.

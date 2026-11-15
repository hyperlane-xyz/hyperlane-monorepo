# Canonical admission order

Fresh canonical messages now pass the configured whitelist, blacklist, address rules, runtime message rules and cached origin-signer rules before the relayer creates a pending actor or reads destination delivery state. Excluded messages retain their canonical history and pending index for later rescan.

The failed V3 functional run exposed the production gap. Its batch whitelist selected four new IDs, but the relayer also admitted four excluded historical IDs as `Confirm.AlreadySubmitted`. Those confirmations polluted the batch's strict retirement count. The fix changes admission order; it does not add a historical allowance or change the 600-second policy. The [failed-run archive](../../zig/bench/results/canonical-admission-before-fix/manifest.json) retains the original evidence, including the successful initial three-message retirement/receipt substage. The complete V3 run failed.

## Admission and recovery

The shared lane checks current policy before app context, Active creation or delivery RPC. Cached signer checks stay local. A denied candidate releases its in-memory loader reservation without deleting history, marking the message processed or immediately reconsidering it in a busy loop. Allowed neighbors progress; removing a rule lets the same message enter on rescan.

Existing durable execution remains recoverable under exclusion:

- EVM recovery requires a validated sealed payload link, context and inherited UUID relation.
- Native recovery requires a fully validated signed operation. Group recovery also validates the durable journal, member authority, shared signed bytes and account nonce reservation. Status or an unsigned intent alone grants no exception.
- The read-only ownership check never normalizes or persists a row, including ManualRetry, allocation failure and corruption paths.
- Recovery actors carry a nonserialized `acknowledge_canonical=false` capability before every operation open. They retain private lifecycle, receipt expenditure and nonce ownership, while withholding canonical processed/pending/terminal mutations and new canonical operation metrics. Reallow can acknowledge settled work without another signature or nonce.
- Recovery-only delivery hooks cannot create a new UR reveal child. Existing independently owned children and admitted confirmation workflows keep draining.

The capability defaults to true for normal callers. Both operation implementations enforce it at persistence, rather than relying only on Root bookkeeping. Completed group cleanup returns no remaining recovery authority for delivered members whose links were removed; their preserved canonical rows can still be acknowledged after reallow.

## Policy boundaries

Rust filters canonical rows before constructing `PendingMessage`. Its classic prepare/submit queues also recheck rules at pop, after pressure or retry waits; Confirm is exempt. Native operations now perform that pop check before the delivered shortcut. Cooperative I/O retains the permit, while retry, reprocess and hard-error paths invalidate it. A denied fresh pop releases Active capacity.

Rust Lander checks again after payload construction and before handoff. The EVM driver now rechecks current message policy and cached signer rules immediately before its first seal/link/UUID/enqueue. Existing sealed replay remains owned work.

New native groups also perform a final **local all-member check** after awaiting quote/delivery work and before creating an intent journal or executable signature. This is an explicit fail-closed improvement: Rust classic batching does not have that second post-quote check. Existing signed-group replay and nonce ownership are unchanged.

## Verification

The frozen component matrix joined successfully with all 18 source/test pins unchanged. Counts include imported test roots; neither mode skipped tests.

| Scope                               | ReleaseSafe | ReleaseFast | Evidence                                                                                                  |
| ----------------------------------- | ----------: | ----------: | --------------------------------------------------------------------------------------------------------- |
| Native/group/admission aggregate    |  120 passed |  120 passed | Real RocksDB recovery, Starknet SDK groups, Tron signer, canonical admission and policy races             |
| Existing EVM driver cases           |   43 passed |   43 passed | Driver and sealed payload regressions                                                                     |
| Independent EVM preseal race checks |   10 passed |   10 passed | Two substantive cases plus eight import roots; message and cached-signer rule flips during gas estimation |

Additional focused evidence includes the original strict regression failing with `expected Active0, found3` (18 passed, one failed), the final 31-test pop/late-rule suite, and a 14-test read-only storage snapshot. The storage cases cover eight protocol-tagged opaque signed tuples; they are not eight live backend or cryptographic tests. Their cases also ran in the final 120-test aggregate.

Actual Root/Factory/RocksDB close-and-reopen tests preserve signed scalar/group identity, nonce, known receipt costs and canonical pending/processed bytes under exclusion. Reallow acknowledges without resigning. Adversarial tests cover malformed authority, foreign group ownership, missing nonce/current reservations, allocation failures, ManualRetry and duplicate canonical effects. EVM preseal tests refresh real runtime rules inside the final gas-estimate response and prove no link, UUID, enqueue, nonce or key use before reallow; already sealed replay retains its UUID.

The tests are permanently imported through `native_group_tests.zig` into the native DB aggregate. The default dependency-light root is unchanged. Independent code/security review found no unresolved blocker on this snapshot.

## Provenance and remaining acceptance

The [manifest](../../zig/bench/results/canonical-admission-order/manifest.json) contains 58 deterministic gzip payloads: exact source blobs, commands, logs, independent reviews and a patch against base `853c1505921715054fd87e944a98d876d51a71c2`. Seven production files changed; the archive records 16 changed source/test files and 18 frozen pins. The staged blobs matched the frozen worktree. Every compressed and decoded hash/length was checked in [verification.json](../../zig/bench/results/canonical-admission-order/verification.json).

The original archive was sealed before the normal source commit. The separate [commit receipt](../../zig/bench/results/canonical-admission-order/commit-receipt.json) binds it to `e0b95ebf0189e3cc75c3ae1e48a2d9581006e8d0`, committed with normal hooks and all 18 pins unchanged. It preserves the original precommit manifest and verification bytes. Earlier 114/43 candidate results are retained as historical evidence because they preceded the complete capability, pop and handoff fixes. The address-fixture diagnostic used ASCII hex where the policy config requires decoded bytes; correcting that fixture preserved its strict assertions.

These are functional component results, not performance measurements or acceptance of rebuilt role binaries. Root owns the broader frozen-source gates, normal hooked commit, fresh Zig build phases and subsequent exact-binary functional proofs. Old `516` runtime binaries and the `853` V3 proof do not validate this new production snapshot.

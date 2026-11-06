# Native submission ownership and Starknet groups

The native lane now honors the existing submission backpressure settings and submits Starknet message batches as one InvokeV3 transaction. A batch keeps each message's own authority and frozen gas weight while sharing one ordered call body, submission nonce, signed payload and transaction identity.

This is functional recovery evidence. It does not establish performance, Linux container acceptance, a deployed service, or mainnet tracking. The before/after benchmark and complete role acceptance gates belong to the final rewrite validation.

## Source behavior

Rust enables `OpSubmissionConfig` for Ethereum, CosmosWasm, Sealevel and Starknet (`rust/main/hyperlane-base/src/settings/chains.rs`, `operation_submission_config`). Its prepare tasks check the submit queue threshold before an admitted batch and sleep150ms while held. Zero blocks fresh preparation; already-ready, signed and confirmation work continues. A positive threshold can overshoot by one admitted batch.

Starknet `Mailbox::supports_batching` returns true. `process_batch` builds all process calls and passes them to one `account.execute_v3(calls)`; its comment and returned failed indexes specify all-or-none execution. See [mailbox.rs](../../rust/main/chains/hyperlane-starknet/src/mailbox.rs).

A permanently retained consumed nonce was a real recovery gap. Rust's [send_and_confirm](../../rust/main/chains/hyperlane-starknet/src/utils.rs) propagates send and receipt errors, [classic submit](../../rust/main/agents/relayer/src/msg/pending_message.rs) clears metadata and reprepares on `ErrorSubmitting`, and [batch submission](../../rust/main/agents/relayer/src/msg/op_batch.rs) retries mailbox submission. The Zig path preserves its stronger durable signing boundary, but can now retire an old signed identity after explicit finalized consumption and absence proofs.

## Durable boundaries

- Select actual native ready, unsigned process intents. Imported Rust `ReadyToSubmit` without a private native intent still counts toward backpressure, but must hydrate through ordinary preparation before grouping.
- Recheck canonical or receipt-ID authority, policy, gas admission and origin-signer rules before preparing/signing. A cold recovered ready or signed actor performs Source's initial origin lookup/backoff; a warm secondary gate stays cache-only. Non-Active group members use a bounded retained state map and the existing shared signer owner/cache.
- Prepare one fresh group quote/nonce. Every resulting intent retains its own message authority and binds the complete ordered manifest, original intent digest and original gas weight. All-zero weights use singleton refresh/submission before any group query; mixed zero weights retain a real zero-cost row.
- Commit the group journal and every replacement intent in one synchronous Rocks WriteBatch across origin namespaces in the same physical DB. Lock distinct Stores in stable namespace order; no network or key callback runs under those locks.
- Sign once. The callback commits one identical signed payload/hash into the group and every member row before any broadcast. Ordinary scalar key callbacks reject durable group ownership. Every commit error is treated as uncertain until durable state is read again.
- Restore group state before allowing ready actors to sign. Replays use the exact saved body, nonce, signature and transaction identity. Receipt/finality drain remains available under current sender denial; live policy and origin sender gates still control transmission.
- Failed canonical receipts and nonce-superseded retirement reset all unfinished members atomically. Per-member drivers cannot reset signed group generation/identity independently. Already-completed members remain completed.

The current pointer names at most one pending nonce owner. A separate full-Felt nonce reservation survives nonfinal inclusion. Inclusion allows higher-nonce work, but a reorg can replay the original lower transaction. Even if every message independently completes, mailbox delivery alone cannot release its unused nonce: cleanup requires a current finalized canonical outcome or an explicit consumption proof. Finalized failure, nonce evidence, exact original intents and signed bytes remain in the private group archive.

Recovery performs at most one current group plus two old-group entries per pass. A retained priority bit alternates current-first and old-first before callbacks. Both phases share one absolute owner deadline and unchanged physical RPC timeout; the second phase runs only with remaining budget. This prevents a blocked higher nonce from starving its orphaned lower predecessor and prevents repeated old-group deadlines from starving healthy current work.

## Finalized nonce evidence

[Backend and proof details](starknet-nonce-proof.md) cover process and announcement validation. A consumption proof binds the exact signed account, chain, operation authority, full32-byte saved/observed nonces and canonical block hash. It requires configured-finalized `getNonce` at one height to exceed the saved nonce, a typed absent receipt, and matching before/after headers.

An unfinished process member additionally proves mailbox absence at that same height. Each member receives its own digest/generation binding. A completed group needs consumption independently of message absence. Scalar operations validate the proof before retirement; groups validate every unfinished member and commit the complete transition atomically. Receipt uncertainty or equal/lower/noncanonical/pending evidence retains signed ownership. No synthetic zero-fee record is written when the actual receipt is unknown.

## Accounting and observations

One canonical receipt is allocated by the frozen original gas weights using integer floor division. Each message/transaction expenditure marker and aggregate are committed together, making replay idempotent. Zero shares are present records. The journal stores the whole amount, allocated sum and unallocated rounding dust; final receipt data refreshes a provisional observation before archive. Actual tests verify101 =25+75+1 and103 =25+77+1. All-zero candidates remain singleton submissions with the full singleton fee; this is the explicit conservative alternative to Rust's zero-division fallback.

A moved finalized canonical receipt updates the stored fence without restarting the600s window; a subsequent matching observation releases settled ownership. Every message still requires its own finalized delivery proof at confirmation eligibility. Submitted events count all members, including those outside a reduced Active cap, once per generation in this process; historical included recovery does not replay counters. A prior per-member delivery observation and a delayed shared receipt cannot count the same submission twice. Optional telemetry allocation/series failures do not authorize, prevent or retain transaction effects.

## Validation

The final focused native aggregate passed **95/95**, zero skips: **73 named functional tests and22 import roots**. The16 recorded source/test files remained byte-identical throughout the run. Zig0.15.2, ReleaseSafe, actual RocksDB and the existing native Starknet crypto library were used on an ARM macOS host. Starknet RPC responses are deterministic in-process transport fixtures; the public-relay compatibility cases use actual loopback HTTP. This is not an OS process/container restart claim: the recovery case closes/reopens the actual Rocks database and recreates the Factory/Lane while retaining the external fixture's effect counters.

Coverage includes:

- cross-origin common signing barriers; pre/post-WAL failure, post-commit reload OOM, full allocation sweeps;
- actual SDK signing, lost response, actual DB/Factory/Lane restart, exact-byte replay,24 seeded crash schedules;
- zero/positive queue limits, admitted overshoot and popped PIO exclusion;
- all-zero singleton fallback, mixed zero, canonical fee shares/dust and once-only stored costs;
- nonfinal and mixed-delivery reorgs, all-delivered unused-nonce hold, full-Felt scalar/group retirement and negative pinned proof cases;
- ordinary receipt failures, per-member final-failure interleaving, moved canonical receipt and bounded rotating recovery;
- lower5/higher6 dependency recovery and three old hashes exhausting the owner deadline while healthy current signing/broadcast progresses within four passes;
- actual cold origin-source lookup/backoff and rule changes for grouped recovery and non-Starknet Tron ready/signed recovery;
- actual control queue/manual reprocess, inactive-member metrics, prior-member/delayed-common observation deduplication,600s confirmation and fresh post-RPC time.

All new DB-backed cases are permanently imported by `zig/src/db_tests.zig`; the default libc-only root is unchanged. The generic Control timing variable received an explicit optional type so the same code compiles for unobserved test adapters.

The combined run also exposed an existing test-only public-RPC server hang: a50ms extraction can validly expire after its chain check and never send the fixture's second expected request. A captured stack showed the test in `join` and its fixture thread in `accept`. The deadline fixture now bounds optional tail acceptance and tolerates only the expected peer-close errors after a real request, retaining timeout-kind/metric/no-admission assertions and asserting one or two actual requests. Production public-relay behavior was unchanged.

Exact commands, source hashes, native-library qualification, raw logs and the historical pre-priority94/94 candidate are in [the evidence directory](../../zig/bench/results/starknet-group-runtime/README.md). Full hashes are stored losslessly in gzip JSON; decompression is ordinary `gzip -dc`.

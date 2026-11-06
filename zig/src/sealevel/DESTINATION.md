# Sealevel destination primitives

`root.zig` exports `transaction`, `ism`, `metadata`, `mailbox`, `announcement`,
`accounts`, `instructions`, and `lifecycle`. These modules construct and verify
actual native transactions; they do not discover keys or implicitly broadcast.
`agents/destination/sealevel.zig` owns the durable actor integration separately.

## Serial resource and deadline ownership

Borrow one `agents.chain_source.Resources.clients.sealevel` per retained job.
Do not share its mutable RPC ID, options, or HTTP client between concurrent jobs.
Set/restore `provider.Client.deadline_ns` to the job's absolute monotonic
nanosecond deadline (`provider.Client.nowNs()` supplies the same clock). Its
`call` wrapper shrinks connect/total timeouts before every RPC and checks after
completion. Getter fixpoints, ALT reads, simulation, blockhash, submission and
receipt checks use that wrapper. Production requires the deadline-native
transport; the standard HTTP transport is for local fixtures.

Helius uses its own `cloud.http.Transport`. Bind the same absolute job deadline
and cancellation with `scraper.receipts_common.DeadlineTransport` over an owned
`HttpTransport`. `Input.concurrent_estimate_reads=true` overlaps the Helius read
with simulation using one helper thread, joined before returning on every path.
This option requires thread-safe allocators and an independent oracle HTTP owner
(the native Curl client itself supports concurrent calls). A bounded destination
worker pool bounds helper threads. Constant fees never create a helper. The
sequential default supports simple deterministic fixtures.

## Metadata

```
var native = sealevel.ism.Client{ .mailbox = &mailbox, .identity = optional_key };
var source = sealevel.metadata.Source(Origin){
    .allocator = allocator, .ism = native, .origin = origin, .cancel = token,
};
var builder = relayer.metadata.Builder(@TypeOf(source)){
    .allocator = allocator, .source = &source,
};
const program = try mailbox.recipientModule(message.recipient);
const bytes = try builder.build(program, message);
```

Module addresses retain all 32 bytes; validator identities retain 20 bytes.
`Origin` has the existing EVM source history/quorum interface. Composite module
13 resolves the production `VerifyMetadataSpec` account fixpoint, then builds
inline Null, message-ID multisig, aggregation, trusted-relayer, and CannotVerify
nodes. Aggregation evaluates all children before selection, prioritizes non-Null
successes in source order, and fills remaining slots with Null. A reorg refusal
in any branch aborts the whole build. Trusted relayers require a configured
identity distinct from the fee payer. Construction caps depth13/nodes100 by
default. Native-spec return decoding independently caps depth16/nodes256.

`verifyCandidate` really simulates Verify and returns `cost=null`: it does not
invent EVM gas or copy Rust's temporary zero-cost placeholder. External SVM
routing/aggregation getter interfaces are not implemented by the production
Rust SVM adapters; native composite specs provide those behaviors instead.
Composite child reads are currently visited serially; each child quorum still
uses the origin's all-peer asynchronous engine.

## Prepare, sign, persist, submit

1. Resolve `mailbox.processInstruction(...)`, including dynamic recipient,
   verify and handle account fixpoints and signer-privilege checks.
2. Call `transaction.prepare(allocator, read_client, Input)` with the actual
   process instruction, payer, configured ordered ALT keys, submitter, fee
   oracle and fee policy. Match ALT override configuration before this call.
3. The result owns `compiled.bytes`, signer keys/count, real `estimate`, and
   finalized `blockhash{hash,context_slot,last_valid_block_height}`. Complete
   simulation/fee reads happen before final blockhash selection. CU limit is
   `min(1_400_000, saturating_u32(units*11)/10)`; priority price is
   `saturating_u64(min(raw, optional_cap)*numerator)/100`, numerator default110.
   Missing, zero or out-of-u32 simulation units fail. Simulation errors take
   precedence after both reads complete, matching Rust.
4. Ask the credential manager to sign exactly `compiled.bytes` for every
   authorized signer, then `prepared.attach(allocator, signatures)`. It checks
   every Ed25519 signature and exact message. Disposable fixture seeds may use
   `prepared.sign`. The native identity is the first full64-byte signature.
5. Persist signed bytes, full native signature and blockhash lease before
   calling `transaction.submit(submit_client, wire, skip_preflight)`. The wrapper
   invokes `sendTransaction` once and validates the returned ID against the
   signature. Injected transport retry policy belongs to the caller. Every
   transport error after persistence is ambiguous; reconcile before replacement.

Normal RPC uses compute-budget unit-price instructions. Jito uses the exact
production fixed tip account and a system transfer:
`max(1000, saturating_u64(compute_units*price)/1_000_000)` lamports. Caller supplies
configured submission endpoints; the Rust default Jito URL is
`https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true`.
Confirmation always uses the normal read client, independently of submission.
`prepared.feeQuote(read_client)` additionally reads the real `getFeeForMessage`
quote at or after the selected blockhash context, including base/signature fees.
An unavailable quote is an explicit error, never a fixed5000-lamport guess.

No preparation method broadcasts. No submit method silently replaces a blockhash.

ALT snapshots are fetched in configuration order, owner/executable/state checked,
same-slot extensions hidden and deactivation checked against real SlotHashes.
At most32 configured ALTs are accepted. This implementation refreshes snapshots
for each preparation instead of Rust's static cache, so it performs extra reads
but cannot silently retain deactivated data. Packet limit1232 applies after
reserving every signature, including legacy and v0 messages.

## Receipts and expiry

`transaction.finalizedReceipt(read_client, signature)` returns null when the
finalized transaction is unavailable. Otherwise it checks native signature and
slot, finalized history status, membership in finalized `getBlock` signatures,
and re-reads the block hash before publishing a result. Failed transactions are
returned explicitly; success is never inferred from a signature acknowledgement.
`lifecycle.Lease.observe` reports blockhash expiry as reconciliation, not proof
of nondelivery. Recheck mailbox delivered/history before any replacement.

## Evidence

`--test-filter SVM` covers real loopback HTTP simulation/getter/fixpoint/submit/
receipt schemas, missing return data, ten-iteration nonconvergence, full native
signature/ack mismatch, canonical hash change, same-job deadline, ALT ownership,
late-branch reorg refusal, and every inline-builder allocation failure.

`altvm/fixtures/svm-destination.json` contains eight complete instruction/message/
signature fixtures generated independently with pinned actual Solana SDK crates:
RPC/Jito × legacy/v0 × normal/saturating price. `svm-ism.json` uses the actual
production composite-ISM and multisig-ISM programs/interfaces for Borsh/PDA/data.
Regenerate from the isolated Rust oracle:

```
python3 zig/tools/fixture_pack.py restore-locks
cargo +1.98.0 run --manifest-path zig/src/altvm/reference/Cargo.toml --locked --offline -- svm-destination
cargo +1.98.0 run --manifest-path zig/src/altvm/reference/Cargo.toml --locked --offline -- svm-ism
```

These are local disposable-chain/fixture tests, not mainnet submission evidence.

## Origin runtime address rules

`signers.fetchTxSignersBySequence(client, mailbox_value, sequence, ?native_hash)`
returns an optional owned slice of all32-byte native signer keys, in transaction
account-key order. Free it with `client.rpc_client.allocator`. The mailbox must
borrow the same finalized client. Every signer is preserved, including sponsored
transfer depositors distinct from the fee payer.

A known64-byte hash skips dispatch discovery. Without one, the helper reads and
authenticates the dispatched-message PDA, scans that immutable dispatch slot and
its immediate predecessor with the production LogMeta matching rules, then reads
the exact transaction. It never uses later PDA-touch signatures as evidence.
Unavailable blocks/transactions remain retryable errors. A fetched block with no
single matching dispatch produces `Some(empty)`, matching production Rust's
permanent-unknown case. Native transaction identity, slot and canonical block
membership are checked; missing-hash discovery also rechecks the resolved block
hash. This canonical fence adds one block RPC relative to the Rust helper.
No caller should invoke this path when runtime address rules are disabled.

`log_meta.zig` now owns the shared raw transaction matcher used by both signer
lookup and scraper indexing. Its nine actual production Rust fixture cases still
cover ALT-loaded keys, inner instructions and reverted siblings. Remote base58
lengths and total static/loaded key counts are bounded before conversion.

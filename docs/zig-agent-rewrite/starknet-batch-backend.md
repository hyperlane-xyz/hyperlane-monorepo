# Starknet batch backend

The native backend now constructs, signs and broadcasts one InvokeV3 containing
multiple mailbox process calls. Each member keeps its own operation authority and
persisted intent, with the same ordered manifest, nonce, transaction hash and
signed bytes. Component verification passes **28 tests, zero skips** using the
existing native crypto library and immutable SDK fixtures.

This closes the backend primitive gap. Runtime group admission, atomic journal
transitions, all-member policy checks and crash recovery remain a separate
integration gate. These results are correctness checks, not benchmark results or
whole-rewrite acceptance. Commands, raw logs and source hashes are archived in
`zig/bench/results/starknet-batch-backend/manifest.json.gz`.

Rust `chains/hyperlane-starknet/src/mailbox.rs:206–245` returns
`supports_batching=true` and submits `account.execute_v3(calls)`. Classic relayer
`agents/relayer/src/msg/message_processor.rs:635–656` reaches `OperationBatch`
when `max_batch_size>1`. Scheduling several singleton sends did not implement
that behavior. The existing Starknet transaction encoder, SDK fixtures, signer
and provider already support multi-call V3; the backend reuses them.

The API in `zig/src/agents/destination/starknet.zig` is:

| Method                                   | Contract                                                                                                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepareBatch(inputs, maximum_members)`  | At least two ready scalar process intents. Validate all members before one fresh nonce and combined query quote. Return owned per-member `Prepared` values and whole-transaction quote. |
| `validateBatch(members)`                 | Require the complete ordered group, shared transaction and manifest, valid intrinsic process-call/authority bindings, and matching member quote fields.                                 |
| `sign(representative, persistence)`      | Persist intent before executable signing; persist the one signed hash/bytes before return. Runtime must provide a group journal callback.                                               |
| `broadcast(member, signed, persistence)` | Validate the same shared hash, signature and exact canonical signed bytes against any member; require signed persistence before sending.                                                |
| `memberReceipt(member, receipt)`         | Check shared transaction identity and preserve canonicality/finality evidence; allocate actual fee by the member's frozen original L2-gas weight.                                       |
| `refreshPrepared(unsigned_scalar)`       | Validate and re-quote the original process call with a fresh submission-time nonce and scalar quote. Keep authority/generation. Never use for signed recovery.                          |

`PreparedBatch.deinit()` owns every returned member and its array. Manifest IDs,
source intent digests and optional origin hooks use lowercase 64-character hex
strings without `0x`. Each manifest entry binds origin, generation, original
scalar intent digest, gas weight and estimated cost. Each member's top-level
`gas_limit` and `estimated_cost` retain its original quote for existing per-message
policy handling. `batch_gas_limit` and `batch_estimated_cost` carry the combined
query estimate and full resource-bound budget plus tip.

Intrinsic restore validates every ordered decoded mailbox process call against
its message ID, origin and destination, then binds the current member's outer
authority, generation, hook and quote to the manifest. Runtime must additionally
compare every manifest source digest, authority and frozen quote against the
previous scalar state before its guarded atomic restage. A digest alone cannot
reconstruct or prove that previous state. There is no independent scalar
persistence loop hidden inside the backend.

The strict call decoder accepts both legacy contiguous-offset and modern
account layouts, bounds call count before allocation, rejects overlapping/gapped
legacy offsets and trailing felts, and returns an owned call array whose calldata
slices borrow the original encoded transaction. `prepareBatch` enforces configured
member count and `Provider.max_call_felts` before any query RPC or signature.
Duplicate members, nested batches, announcements and mismatched authority/call
bodies fail before submission.

Rust uses each member's original L2 gas estimate as its weight:
`mailbox.rs:185`, `pending_message.rs:796` and
`hyperlane-core/src/traits/pending_operation.rs:364`. Starknet `types.rs:53–54`
represents actual fee as gas used at unit price one. The native allocation uses
an exact wide product followed by integer floor division. Its per-member gas and
token expenditure therefore match. For fee 101 and weights 1:3, shares are 25
and 75, leaving one unit of rounding dust. It never charges a full transaction
fee to every member.

All-zero weights return `StarknetBatchZeroWeight` before query signing or RPC.
Runtime can submit those candidates as refreshed singleton operations and charge
each actual singleton receipt. This is a conservative edge difference from Rust's
division-failure accounting fallback, which can fall back to a whole-transaction
fee per operation. Mixed zero/nonzero weights remain a real shared transaction;
a zero-weight member receives a present expenditure record with zero values.

| Verification                                             |                                                                                                                         Result |
| -------------------------------------------------------- | -----------------------------------------------------------------------------------------------------------------------------: |
| Combined SDK and batch root, ReleaseSafe                 |                                                                                                           28 passed, 0 skipped |
| New batch-specific substantive tests                     |                                                                                                                       9 passed |
| Existing immutable SDK Invoke vectors decoded/re-encoded |                                                                                                     14, both account encodings |
| Generated codec cases, seed `0x62746368636f6465`         |                                                                                                                            260 |
| Generated allocation cases, seed `0x6261746368666565`    |                                                                                                                          1,024 |
| Query cancellation/deadline/pending/OOM propagation      |                                                                                                         16 injected boundaries |
| Allocation ownership                                     | Every allocation failure in prepare, validation, restored intent and receipt allocation unwinds without leaks or swallowed OOM |

The actual native test verifies one chain/nonce/query/tip sequence, one query
signature and one executable signature, then one broadcast. Intent-persistence
failure prevents executable signing; signed-persistence failure prevents
broadcast. Restoring the second member's exact persisted intent can broadcast the
same signed bytes without another nonce read, fee query or signature. Canonical
receipt verification and finality are shared, then expenditure is allocated.

Negative cases include incomplete/reordered/duplicate membership; member ID,
origin, generation, weight and cost changes; own-body and in-memory quote changes;
combined budget/estimate changes; different mailbox/call/message content, nonce,
public key, transaction identity and signature. Receipt identity mismatch fails
without RPC. Unknown receipt spend remains unknown. Generated allocation checks
use independent floor intervals, conservation and dust bounds, including maximal
u256 fees, maximal u64 weights and mixed zeros. Codec checks include empty,
singleton, maximum-size, truncation and trailing-data cases; immutable SDK oracles
remain separate from generated roundtrips.

No production credentials or network endpoints were used. Tests load the existing
local crypto library and use public fixture keys. No SDK rebuild, extra worker,
Pool, role binary, production call or performance measurement was performed.

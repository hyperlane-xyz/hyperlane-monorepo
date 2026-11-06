# Starknet nonce retirement

Mailbox delivery alone cannot release a retained signed account nonce. A group
can be orphaned while another account independently delivers its messages. If
the original nonce is then reused, two executable transaction identities can
compete for that nonce. Missing receipts and elapsed wall time do not resolve
that uncertainty.

The backend now validates the saved executable InvokeV3, including account,
chain, public key, transaction hash, signature and exact canonical bytes. Scalar
process calls additionally bind the mailbox target, process selector, decoded
message ID and origin to the operation authority; batch manifests bind each
member through the same process-call validator. It
reads the account nonce at an explicit height selected by the configured reorg
period. Canonical headers at that same height fence the nonce, receipt-absence
and historical state reads. The observed nonce must strictly exceed the saved
nonce. Both values and the account remain full 32-byte Felts; legacy u64 proof
fields remain zero. A pending header, equal/lower nonce or any present receipt
does not establish retirement. Provider/control/OOM errors propagate.

`Factory.starknetConsumedNonceProof` returns this consumption evidence without
requiring message absence. It lets the group coordinator decide whether an
all-delivered group's nonce reservation can be released. It cannot authorize
retirement of an undelivered actor: `absence_checked` is false.

`Factory.starknetNonceRetirementAt` revalidates a group's common evidence and
checks an individual message's mailbox absence at exactly that height. It emits
the member's own intent digest and generation while retaining the shared signed
identity/account/nonce. Ordinary scalar `Factory.retirementProof` obtains the
same evidence with historical mailbox absence directly. Group atomic retirement
and reservation cleanup belong to the coordinator/Operation implementation.

Announcements use historical announcement state, rather than mailbox delivery.
Existing expected-announcement domain/mailbox/digest/recovered-validator checks
run first. The saved signed Invoke must contain exactly the expected target,
announce selector, validator, location and announcement signature. At the same
consumed-nonce height, the actual announcement contract must omit that exact
validator's expected location. A final canonical header fences that query.
`absence_checked` then means absence of the expected announcement. A different
published location does not prove that the expected one was announced.

The height follows existing configured-finality semantics (`height(reorg)`),
including the configured confirmation depth. This does not introduce an implicit
L1-finality requirement or use a latest-nonce-only proof. No receipt fee is
invented when retirement relies on nonce evidence; expenditure stays unknown.
Proof generation does not sign, quote, broadcast, open a key, create a Pool or
start a worker. Broadcast and proof validation share the same saved-transaction
validator, retaining the existing single parse/verification path for broadcast.

Rust Source supports retrying these operations. Starknet `utils.rs:95–104`
selects latest confirmed account state; `send_and_confirm:329–340` propagates send
and receipt failures. `pending_message.rs:767–788` clears metadata and reprepares
on submission failure. `mailbox.rs:213–245` submits one account multicall with
all-or-none execution. `validator_announce.rs:79–94,193–195` constructs and sends
announcements through the same account path. The explicit nonce proof adapts
that retry capability to durable retained signed bytes; Source does not expose
this same proof API.

Tests use the existing native Starknet SDK, deterministic public keys and a
scripted JSON-RPC transport. They assert exact numeric-height/account/contract
requests, a nonce above u64, scalar and shared-group binding, equal/lower nonce,
pending/present receipt, future height, evidence tampering, wrong account/chain/
identity/canonical bytes, same-height reorgs, cancellation/control and every
allocation failure. Announcement cases use an actual prepared and signed SDK
Invoke, exercise present/absent/different locations, reject mismatched expected
announcements and signed target/selector, and fence a reorg after the historical
query. Existing batch signing/broadcast/receipt tests are rerun.

Exact [source hashes and results](../../zig/bench/results/starknet-nonce-proof/manifest.json.gz),
[commands](../../zig/bench/results/starknet-nonce-proof/commands.json.gz) and lossless
logs are archived under `zig/bench/results/starknet-nonce-proof/`. JSON artifacts
are packed losslessly; exact raw local mirrors are ignored. Restore with
`python3 zig/tools/fixture_pack.py unpack <artifact.json.gz>` when a raw JSON path
is needed. Chunked raw digests are recorded in `packed-historical-artifacts.json`.
These primitive results do
not replace actual Root crash/restart/group-retirement acceptance. No production
credentials, requests, SDK rebuild, role binary or performance measurement is
part of this slice.

| Verification                                 |               Result |
| -------------------------------------------- | -------------------: |
| Nonce/announcement proof root                | 16 passed, 0 skipped |
| Existing Starknet aggregate plus proof cases | 44 passed, 0 skipped |

The focused root includes five substantive cases and eleven import roots; those
cases are also included in the aggregate. Independent review identified missing
scalar process calldata-to-authority binding in the earlier implementation. The
final snapshot includes that check and actual signed negative cases for target,
selector, message ID and origin. Historical 15/43 logs are explicitly marked as
non-acceptance evidence in the archive. The proof wrapper is registered in the
default native test root as well as the component wrappers.

[Independent review](../../zig/bench/results/starknet-nonce-proof/independent-review.md)
found no unresolved blocker in the corrected snapshot. Its
[final verification](../../zig/bench/results/starknet-nonce-proof/independent-status.json.gz)
repeated 16/16 tests with zero skips, matched all ten source hashes and the SDK
before/after, and verified the exact 16/44 measurement logs. This supplements the
original capture-time metadata; accepted measurement and log bytes are unchanged.

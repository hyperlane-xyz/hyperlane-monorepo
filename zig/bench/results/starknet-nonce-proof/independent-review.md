# Independent final nonce/announcement proof review

No unresolved blocker found in the released corrected primitive snapshot.
One concrete authority defect was found and fixed before release; no Source
edits were made by this reviewer.

## Finding closed before final acceptance

P2: earlier scalar-process nonce proof validated configured account/chain,
canonical signed bytes/hash and SDK signature, but only batch process calldata
was bound to its outer message authority. A valid saved signed scalar with a
wrong target/selector or relabeled message ID/origin could authorize retirement
for the outer operation's absence. Protocol owner confirmed the defect and added
one scalar decodeCalls + existing validateProcess check in Starknet.nonceProof,
before any RPC. The scope is proof authorization, not a broad broadcast API
change. Four actual SDK-signed target/selector/message/origin negatives now
reject with zero network requests. The prior15/43 snapshot is historical only.

## Final verification

I independently executed the exact released focused command after the owner's
explicit freeze: **16/16 passed**, zero skips, source hashes unchanged and equal
to all10 released manifest entries. This is five substantive cases plus eleven
import-root declarations; the focused suite is a subset of the owner's44/44
Starknet aggregate, so those totals must not be added as distinct coverage.

I also verified both archived gzip hashes, decompressed-byte hashes/sizes and
successful result lines from the owner's16/44 evidence. Existing SDK digest
remains the recorded3cc4267b... DSO; no Rust/Cargo/debug compilation, SDK rebuild,
role binary, container or benchmark was run. The exact Zig focused command
reused the existing component compiler cache and completed without Source drift.

Command/env: /tmp/ziggy-nonce-proof-independent-command.json.
Raw output: /tmp/ziggy-nonce-proof-independent-tests.log.
Exact Source hashes/check results: /tmp/ziggy-nonce-proof-independent-result.json.
Released owner archive: zig/bench/results/starknet-nonce-proof/manifest.json.

## Reviewed authority and finality boundaries

- Starknet.signedTransaction/restore checks executable InvokeV3, configured
  account/public key/chain, canonical full bytes, transaction hash and SDK
  signature. Nonce/account retain full32-byte Felt values. Scalar processes now
  decode exactly one mailbox/process call and bind decoded message ID, origin
  and destination; batches validate all ordered manifest calls/members.
- Provider nonce is read at H<=current configured-finality height, not latest.
  Observed nonce must exceed saved nonce without u64 truncation. An optional
  earlier consumption proof is rechecked against actual H header/account/
  boundary/observed nonce and native identity before per-member rebinding.
- Only typed transaction-not-found code29 establishes receipt absence. Present
  results, including pending or malformed result bodies, do not authorize
  retirement. Other provider/decode/control/OOM errors propagate. Starknet's
  hash-addressed receipt RPC has no historical-block argument; positive nonce
  consumption and mailbox/location reads are pinned to H, with same-H header
  fences, rather than inventing an unsupported historical receipt query.
- Process absence queries the correct mailbox/message at H. HeaderH before and
  after nonce/state reads must match; pending/wrong-height/reorg responses do
  not release ownership. Equal/lower nonce and future-H supplied proof do not
  authorize retirement.
- Announcement retirement first validates recovered expected Announcement
  authority/domain/mailbox/digest/validator. It reconstructs the exact one-call
  target/announce selector/validator/location/signature calldata and compares
  all felts against the saved executable. Historical storage locations use the
  configured announce target at the same consumed-nonce H, followed by an
  additional same-H header fence. Present expected location prevents retirement;
  a different location does not substitute for it.
- Unknown receipt fee remains unknown: this proof API produces no expenditure.
  Downstream scalar retirement/history and group retired snapshots were checked
  for fabricated accounting writes; they do not create a zero-fee row or refund
  previously recorded expenditure. Group fee-audit fields are null when no
  canonical receipt supplies them. Actual atomic Root retirement/ledger tests
  remain runtime-owner acceptance, not newly claimed by this primitive review.

Residual scope: this closes the released nonce/announcement primitive review.
Parent/runtime still own atomic all-member integration, standard root wiring,
global/role gates and final emitted SDK/binary verification before measurements.

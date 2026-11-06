# Native destination boundary

`types.zig` owns canonical recoverable intent, tagged native identity and durable
mutation callbacks. `Prepared.restore` validates exact canonical bytes/context.
`signature512` retains all 64 signature bytes. `hash256` retains chain-native
bytes; Aleo compressed little-endian IDs are decoded by its SDK. Null gas/cost
means unestimated and cannot pass a gas-payment gate as zero.

`Factory.open(allocator, stable_chain_resources, transaction_signer, credentials,
options)` borrows an exclusive, stable `agents.chain_source.Resources`; join all
jobs before destroying either owner. The checkpoint signer is independent of the
configured native transaction signer. `identityContext()` commits public native
signer/account, chain, mailbox and announcement deployment. Each process authority
also requires an explicit configured origin-domain/hook binding. No secret,
credential token or RPC URL enters the context digest. `refresh(credentials)`
renews borrowed cloud leases between serialized jobs.

The dispatcher supports seven configured native protocol tags through six concrete
backends; Cosmos CW/native share one backend. Ethereum remains on the role's single
Lander nonce allocator. Every effect validates actual configured deployment and
signer, with an initial chain/domain check. A retained supervisor must supply the
absolute deadline/cancellation token; native HTTP and isolated Aleo CPU workers
observe that token. Per-job deadline/cancel pointers are restored on return.

`source_metadata.Source(Origin)` supplies full32 module addresses over all seven
native tags. `Factory.Options.metadata_executor` borrows the process-wide bounded
executor; forks own typed clients, RPC IDs, HTTP/RPC continuation journals and an
origin checkpoint read session. They borrow the same global transport owners and
byte budget; no child owns a new I/O pool or private signer. The original absolute
monotonic deadline bounds each fork and physical request. The external aggregation
builder preserves first-completing threshold semantics; SVM inline composite specs
use the separate all-results join and scan every refusal before selection. Parent
Resources/Origin/transports must outlive every retiring executor job.

Concrete behavior:

- SVM: actual account-meta fixpoints and fresh ALT validation, simulation, priority
  oracle/Jito policy, real `getFeeForMessage`, immutable compiled-message recovery,
  configured payer/identity signatures and full native signature reconciliation.
  `concurrent_svm_estimates` overlaps Helius and simulation reads using a separate
  deadline/cancel scoped HTTP owner; callers must provide thread-safe allocators.
  An ambiguous send returns immediately; a subsequent explicit rebroadcast rotates
  configured submission endpoints using the same bytes and identity.
- Cosmos CW/native: actual SDK account/sequence and simulation, strict DIRECT
  AuthInfo/SignDoc recovery, exact decimal fees, native SHA256 identity and committed
  Tendermint receipt validation. Receipt identity, transaction position, canonical
  block/result code and gas provenance must agree before finality or accounting.
  CW recipient existence checks use ContractInfo;
  only gRPC NotFound becomes false. Transport/auth/malformed failures propagate,
  deliberately differing from Rust's catch-all false.
- Radix: actual process visibility fixpoint and V2 manifest preview, real cost
  units/fee lock, pinned Ed25519 notarization and native intent hash, exact SBOR
  recovery and committed-state reconciliation.
- Tron: actual energy/price/TAPOS/expiration policy, strict protobuf and recovered
  secp256k1 sender, canonical solidified receipt reconciliation.
- Starknet: full felt addresses/account separate from signing key, InvokeV3 query
  estimation/resource budgets, actual L2 gas units, pinned-key signature and native
  hash, exact signed JSON recovery and canonical receipt/finality reads.
- Aleo: actual program mappings/call inputs, exact edition/import snapshots,
  checked fee authorization, isolated local or explicitly delegated proving,
  SDK execution/fee identity binding before signed persistence. A restart restores
  signed authorizations without another private-key read. Native receipt decoding
  preserves rejected original IDs separately from committed fee transaction IDs.
  Confirmed index/transaction/acceptance must match the native decoded block and
  its canonical height lookup before finality or accounting.

The normal lifecycle is prepare, quote, gas policy, optional `applyGasAllowance`,
final quote/policy, stage, approve, sign, persist signed bytes, broadcast and
reconcile. `applyGasAllowance` returns new canonical bytes and is only valid before
staging. Rust consumes that allowance on Cosmos and Tron: AuthInfo/SignDoc or
protobuf fee_limit changes while account/sequence/timeout or TAPOS/timestamp/expiry
stay exact. Other native Rust adapters ignore the supplied gas limit. Recovered
staged intents cannot silently change; defer/reset the unsigned generation first
when a current policy needs different bytes. Aleo uses a separate nonbroadcastable
persisted authorization to obtain an SDK fee quote; real proof work requires the
approved intent gate. Query-only Starknet signatures are likewise nonbroadcastable.

`deliveredFinalized` uses configured finalized state: Cosmos query height, Radix
state version, Starknet block height, SVM finalized account context, Tron solidity
state and Aleo immediate consensus finality. Receipt absence is not proof a signed
transaction can be replaced. `retirementProof` requires a positive finalized
expiry/supersession boundary, exact signed-byte/native-ID validation and a finalized
non-delivery query at equal-or-newer state. Supported boundaries are Tron solidity
block timestamp, SVM last-valid block height (with minimum account slot), Radix
exclusive end epoch (whose ledger version must be finalized), and Cosmos historical
account sequence or immutable TxBody timeout. RPC errors/pruning/local time cannot
supply this proof. Starknet/Aleo retain identity without a finalized failure receipt.

`operation.zig` is a heap-owned serial actor over the existing origin Store. It
commits sidecar+Rust status/retry rows in one synchronous RocksDB batch. Delivered
state, canonical-ID-guarded nonce marker and conditional pending-ID deletion share
that batch. Full tagged IDs and exact signed bytes survive restart; the pure state
machine's SHA256 correlation digest is internal only. Sidecar/status CAS prevents
stale owners from erasing operator Manual actions. Manual retry clears delay/retries
and retains in-flight identities. A finalized failure or typed retirement proof
atomically archives the old signed generation before retry. Deny/allow retains it.
Finalized external delivery needs no local signature and records Rust
Confirm.AlreadySubmitted. Source delay paths preserve normal retry count.

Announcement mode requires a pinned configured target and uses each VM's real
announcement builder/native signer. It never touches process nonce/status/pending
rows. `announcementRetirement` additionally requires the signed announcement digest and
configured target; its proof is explicitly tagged as announcement mode. SVM uses
finalized minimum-slot location absence. Tron cannot bind walletsolidity constant
query absence to an expiry block, so returns null; Cosmos/Radix use pinned
height/state-version location queries. Starknet/Aleo have no expiry retirement proof. The caller owns a
durable public signed-announcement queue; repeated calls
use the signed announcement digest and retain exact staged/signed recovery bytes.

`agents/relayer/native_driver.zig` advances the actual Factory/Actor process path.
Its caller owns queue, resources, credentials, origin history and source signer
cache/backoff callback. Unsigned work checks finalized delivery, recipient, source
gas preflight, policy, origin signers, metadata, actual quote and gas allowance.
Signing and broadcast are separate durable effects. Restart reconciles first;
receipt lookup errors may still obtain an independent positive retirement proof.
Signed policy denial suppresses broadcast while preserving reconciliation. Terminal
non-contract rejection commits actor state, Rust terminal tombstone and conditional
pending removal atomically without marking the nonce processed.

Optional genuine receipt expenditure is projected per VM; unavailable fields remain
unknown. Starknet/Aleo use actual native fee as source gas units, Cosmos truncates
its exact configured rational price product, and Radix preserves source integer
price rounding. SVM uses actual consumed units/native fee, additionally counting a
successful signed Jito tip; this improves Rust's explicit zero-cost placeholder.
Tron requires actual used energy and receipt effective price. Actor accounting
atomically commits the Rust aggregate and a full tagged-native-ID marker, preventing
duplicate charges across crashes, polling and even repeated generations. Conflicting
costs or unfinalized receipts are rejected. Driver reports only a newly committed
expenditure delta. A missing/pruned own receipt does not invent an expense or block
an independently finalized delivery decision.

Focused evidence: `root.zig --test-filter destination` passed
32/32 with native Starknet/Aleo libraries, isolated worker and public parameter
fixture (includes root/import checks). This includes a real local proof, encrypted
delegated response bound to the same execution/fee, independent SDK full-wire
Radix/SVM recovery and mocked broadcast. Native RocksDB actor command passed20/20
(includes import checks), covering crash recovery, full512 identity, stale owners,
nonce replacement, failed-generation history, manual retry, unsigned external
delivery, source delay, gas-floor preservation and positive finalized Tron expiry.
SVM focused regression also rejects an expired lease queried with stale account
context, verifies actual announcement absence at its finalized frontier and refuses
retirement once the location is present. Temporary test roots have been removed;
use `root.zig` and `db_tests.zig`. No test reads production credentials or submits a
live transaction.

Configured SVM `ur_reveal` uses an explicit `Factory.Options.enable_reveals`
relayer feature. The native Driver synchronously enqueues public commit context
before committing the process delivery marker; replay of an already-delivered
actor enqueues without process signing. The retained destination lane calls
`Factory.tickReveal(origin_store, Clock, Times)` for every origin, including when
no canonical message remains pending. Validator announcement factories keep the
feature disabled and do not open CCS credentials. CCS signing uses the separately
configured `ccs_signer`, pinned in reveal context alongside the native payer,
program, mailbox, origin hook and CCS URL.

`reveal_queue.zig` retains route/cycle context, cached CCS authorization, workflow
phase and retry schedule in synchronous CAS rows. `reveal_runner.zig` performs one
bounded phase per call: PDA propagation, token arrival, CCS fetch, full native
prepare/sign, reconcile and identical-wire resend. It preserves the source
5×5-second PDA grace, 360 token polls, 10×5-second CCS404 retries, fixed600k/200k
CU budgets, 30-second-to-10-minute outer backoff and independent duplicate-close
path. Signed work is retained through timeouts or an absent/recreated PDA; only
an exact finalized receipt or strictly expired finalized block height can retire
its full512-bit identity. This deliberately avoids the source timed fresh-blockhash
retry while an older transaction remains viable. Auxiliary completion never
writes Rust process retry/status/nonce markers.

Untrusted CCS accounts cannot grant any signer privilege or include the native
payer (even with a false signer flag, because compiled Solana privileges merge
across instructions). Live CLMM pool ownership and pending/token account context
are checked. Fixed wSOL cleanup refuses a preexisting nonzero payer wSOL ATA.
These deliberate restrictions protect configured transaction authority. No
custom cryptography is introduced.

Actual native RocksDB runner evidence15/15 (including root imports) covers
post-delivery replay, durable CCS authentication, prepared-before-key and
signed-before-broadcast guards, restart, equal-vs-strict lease expiry, retained
identity when the pending PDA disappears, Source duplicate-close detection,
CCS404 delay and cancellation, finalized reveal and close completion. The pure
instruction/security fixture also runs every allocation-failure point.
`reveal_oracle_test.zig` additionally compares37 independent production Rust/Solana
SDK vectors: tick/PDA/ATA/CCS hashing, actual instruction data/account privileges,
compiled messages, exact seed7 signed transactions and signatures. The reference
extracts unmodified production helper bodies, injects only pool-account RPC/minimal
context, and compiles with the real Solana SDK. Source spans and split SHA256
fingerprints are recorded in `zig/reference/reveal/provenance.json`. Regenerate with
`python3 zig/reference/reveal/generate.py --check` after building its pinned reference.
This oracle covers wire construction; native runner tests cover scheduling/durability.

Migration does not equate an empty Zig sidecar with absent Source transactions.
`Operation.inheritedPayloads()` reads the exact bounded Source UUID vector;
nonempty relations block every new stage/key/broadcast under the origin lock,
including existing native-sidecar replay. The Driver can still acknowledge an
independently finalized mailbox delivery without deleting Source UUID relations.
This applies to configured Source SVM/Radix/Aleo/Tron Lander adapters as well as
any unexpected relation. Rust Tron retains typed-call/ABI precursor and historic
hashes, but its provider constructs TAPOS and signs/broadcasts internally; the
persisted row does not retain exact protobuf signed bytes or expiry. An explicit
relation migration/reconciliation owner is still required before fresh native
work on those inherited messages. Receipt absence never clears the guard.

Native role/service integration belongs to the caller; these module tests do not
establish a completed production deployment.

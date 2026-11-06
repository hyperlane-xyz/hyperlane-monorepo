I couldn't save the plan file because the Write tool is disabled in this session, so the full review is below. Nothing was edited.

**What I read.** The validator (`checkpoint_consensus`, `submit`, `rpc`, `validator`), core encoding and signing (`message`, `encode`, `signing`, `types/mod`, `checkpoint`), the local checkpoint store, the startup reorg check, RocksDB (`typed_db`, `hyperlane_db`), the relayer's checkpoint quorum code (`types/multisig.rs`, `message_id_multisig.rs`), the Ethereum and GCP signers, the scraper writer lease, and every `todo!` in lander. On the Zig side I read `message`, `checkpoint`, `signature` and `runtime/validator` in full, outlines of `metadata` and `relayer`, `bench/run.py` and `differential.json`.

**What I didn't read.** The lander dispatcher and nonce handling, relayer intake, gas policy and CCIP-read, the scraper pipeline, the chain adapters, and the S3/GCS storage code.

**`zig/` was changing while I reviewed it.** Files appeared between two of my searches, so these findings describe a snapshot. I did not re-run `differential.json` (`passed: true`). It only covers message encoding and ID, Merkle root and count, and the checkpoint signing hash.

## Verdict

The plan and scope docs set out the right principles but leave byte-level contracts unspecified. They also skip several Rust behaviours that a cleaner Zig port will naturally get wrong. The Zig validator state machine already differs from Rust in ways that would stop delivery (C1, C2) or hide a reorg (H1). Its single "reserved"/"signed" slot can't express Rust's behaviour, so the I/O layer around it can't fix this.

## Findings

### CRITICAL

- **C1 — Zig signs one checkpoint index; Rust signs every one.** Rust queues and signs every checkpoint up to the target, then publishes the latest index (`submit.rs:911-925`, `1434-1501`). The relayer's message-ID multisig fetches the checkpoint at exactly the message's leaf index (`message_id_multisig.rs:41-91`). `validator.zig:75-103` reserves a single checkpoint, and `SigningInFlight` blocks the rest. Result: messages at intermediate indices get stuck.
- **C2 — Different rule for choosing what to sign.** Rust keeps endpoint votes that match local history at each vote's own index, sorts them highest first, and signs at position `required-1` (`submit.rs:673-729`). Zig requires at least the threshold number of _identical_ checkpoints (`validator.zig:87-93`). If the RPC endpoints are even one block apart, Zig never signs.
- **C3 — Big integers (U256) are stored little-endian; u32/u64 are big-endian.** See `encode.rs:103-124` vs `127-168`. Neither doc mentions this. A Zig port that writes U256 big-endian silently corrupts stored gas payments, so the gas policy makes wrong decisions. Decoding a bool also rejects any byte other than 0 or 1 (`encode.rs:181-196`).
- **C4 — Signature recovery is not checked for parity.** Rust uses ethers' recover (`signing.rs:116`) for the relayer quorum (`multisig.rs:241-261`), snapshot authentication (`submit.rs:1226`) and conflict detection (`submit.rs:1326`). Zig's recover is hand-written and stricter: it rejects any `v` other than 27/28 and any high-S signature (`signature.zig:32-38`). Rust and Zig may accept and reject different signatures. Nothing tests this yet.

### HIGH

- **H1 — No halt when RPCs agree on a conflicting root.** In Rust, if enough endpoints agree on a root that differs from local history at an already-signed index, the validator writes `reorg_flag.json` and panics (`submit.rs:582-601`, `1116-1171`). Zig just skips the vote (`validator.zig:82-83`), so it stalls silently and no flag is written.
- **H2 — Two different branches when a checkpoint already exists.**
  - Same signer, different value: write the reorg guard, then panic. Different signer: log a warning and overwrite (`submit.rs:1325-1366`).
  - The second branch is easy to "fix" into a halt, which would break parity.
  - Rust reads the existing file, then writes, with no atomic check in between. I confirmed local storage uses a plain `fs::write`. I didn't read S3/GCS, so whether they use conditional writes is unknown.
  - A single writer per storage location is the only protection. Running Rust and Zig on the same location during migration is unsafe.
- **H3 — Reorg guard behaviour.**
  - Writing the guard retries forever before panicking (`submit.rs:1175-1192`).
  - Startup refuses if the flag can't be read, or exists but can't be parsed (`settings/checkpoint_syncer.rs:131-137`, `local_storage.rs:172-198`).
  - On a halt, Rust drops in-flight signing and write calls (`unless_reorg`, `submit.rs:1267-1276`). Zig with only the standard library can't cancel threads. It needs an explicit rule: discard late KMS results and never write after a halt, with a test.
- **H4 — Handling of the signature `v` byte.**
  - Rust sets `v = 28 - (v % 2)` (`signer/mod.rs:114`). That is only right for inputs of 27/28 or EIP-155 values; a raw 0/1 parity comes out inverted.
  - When packing, `v` is truncated to one byte (`types/mod.rs:75-82`), and a test covers 256 and u64::MAX (`multisig/base.rs:385`).
  - The two signers wrap differently. `Signers::sign_hash` applies the EIP-191 prefix itself; `GcpSigner::sign_hash` signs the raw hash (`gcp.rs:217`). Zig's `signDigest` expects an already-wrapped hash. That risks wrapping twice or not at all.
- **H5 — Checkpoint JSON is a storage contract.**
  - Fields come out in the order `value`, `signature{r,s,v}`, `serialized_signature` (132-character `0x` hex) (`signing.rs:84-110`).
  - Reading also accepts the aliases `checkpoint` and `announcement`.
  - The exact format of `r`/`s` (U256) needs confirming; it is probably minimal `0x` hex.
  - Some objects are pretty-printed and some compact (`local_storage.rs:111,133,151,164`), and `index.json` is a bare integer.
- **H6 — RocksDB key layout quirks.**
  - Keys are `{domain}_{prefix}{key}` (`typed_db.rs:32-50`).
  - The `message_` prefix also matches `message_id_` keys. `retrieve_highest_message_nonce` only works because it filters on suffix length (`hyperlane_db.rs:412-416`).
  - Single-value keys use `[0x00]` as the key (`hyperlane_db.rs:186`, `238`).
  - Checking that the pending-message migration is complete reads RocksDB's write-ahead log by sequence number (`hyperlane_db.rs:233-282`). That can't be done without real RocksDB.
- **H7 — Relayer quorum builder quirks (`multisig.rs`).**
  - Signatures are grouped by root only, but building the result requires every field to match. One signer with the same root and a different message ID makes that index fail, and the range search skips it (`multisig.rs:264-286`, `checkpoint.rs:76-99`).
  - The start index is the `threshold-1`th highest latest index (`multisig.rs:140-146`).
  - Concurrency is 1.5 × threshold, clamped to 1–10 (`multisig.rs:187-188`).
  - The first root to reach the threshold wins, so the result depends on response order.
  - Signatures are ordered by on-chain validator index.
  - For Aleo destinations, missing signatures are padded with `r=s=1, v=1` to the full set (`multisig.rs:289-336`). Zig's `verifyQuorum` requires exactly `threshold` signatures (`signature.zig:82`), so it would reject that padded metadata.
- **H8 — Endpoint de-duplication uses the Rust `url` crate's normalisation** (`rpc.rs:17-33`). Zig's `std.Uri` normalises differently, so duplicates could be counted twice (inflated votes) or distinct URLs merged (changing the threshold). Which URLs are read also differs by protocol: Cosmos uses the gRPC URLs, Tron the wallet-solidity URLs, Radix the core URLs (`rpc.rs:37-53`).

### MEDIUM

- **M1 — Lenient defaults to either preserve or fix, explicitly.**
  - `latest_index` turns read and UTF-8 errors into "no index" (`local_storage.rs:67-83`). That contradicts invariant 10 in `scope.md`.
  - Snapshot reads have a size limit; checkpoint fetches don't (`local_storage.rs:119-127`).
  - Local writes aren't atomic. A torn JSON file makes that index fail to fetch permanently, which blocks it.
- **M2 — Startup `has_messages` depends on response order** (`checkpoint_consensus.rs:95-116`). It needs tests with scripted response order, not random order.
- **M3 — `replay_cannot_improve_vote` compares list positions** (`submit.rs:641-671`). Easy place for an off-by-one.
- **M4 — Zig halts when a block hash differs** (`validator.zig:46-52`). Rust checks roots, not block metadata (`submit.rs:751`). Chains whose block hashes aren't stable could trigger false halts.
- **M5 — Scraper writer lease.** It uses the database server's clock (`clock_timestamp()`) and an advisory lock, and the writer id is `{pid}-{nanos}` (`near_head/store.rs:55-58`, `115`, `482-491`). The simulator must model the database clock. A Zig scraper running in shadow mode must have no write path, or it will take the lease.
- **M6 — Lander placeholders cover more than `scope.md` lists.** There are `todo!()`s in:
  - `ethereum/adapter.rs:424` (`estimate_gas_limit`)
  - `tron/adapter.rs:64`
  - `radix/adapter.rs:315`
  - `aleo/adapter/core.rs:63`
  - `cosmos.rs` (×10)
  - `factory.rs:56-57`

  The parity matrix needs to be per method, not per protocol.

- **M7 — Zig keeps history in a fixed in-memory array** (`validator.zig:30`, failing with `HistoryCapacityReached`). Rust keeps a 32-node incremental tree plus RocksDB and caches only sampled roots (`submit.rs:81-110`). Mainnet trees with hundreds of thousands of leaves break this. It needs a design decision.

### LOW

- **L1** — `zig/reference` builds `hyperlane-core` without the `ethers` feature, so it can't produce signed or recovered test vectors.
- **L2** — Rust's `From<&RawHyperlaneMessage>` panics on inputs shorter than 77 bytes (`message.rs:86-105`); Zig returns an error. Document the difference.
- **L3** — `zig/reference/target/` and `bench/__pycache__/` are untracked build output; add them to `.gitignore`.
- **L4** — Zig and Rust may produce different signature bytes for the same key and hash (ECDSA nonce generation). That's harmless because Rust compares checkpoint values only (`submit.rs:1328`), but signature-byte equality must not be used as a parity check.
- **L5** — `run.py` compares protocol kernels only. `rust-full-build.log` sits next to the kernel results; keep it out of any Zig-vs-Rust build comparison, which `scope.md` forbids.

## Standard-library-only Zig: assessment

- **Covered by `std`:** Keccak, secp256k1 point operations (recovery has to be hand-built and audited), SHA-256/HMAC (enough for AWS request signing and Postgres password auth), JSON, an HTTP client and a TLS client.
- **Not covered:**
  - RocksDB on-disk format and write-ahead log
  - The PostgreSQL protocol
  - protobuf/gRPC (Cosmos, Tron)
  - Borsh and Solana transaction formats
  - SBOR (Radix)
  - Starknet's curve
  - snarkVM proving (Aleo)
  - AWS/GCP KMS and ambient cloud credentials
- **Verdict:** standard-library-only is viable for stages 1–2 plus local file checkpoint storage. Later stages need declared dependencies (librocksdb through C, a PG client, KMS) or a sidecar. That matches `scope.md`'s dependency policy; it must not turn into a quiet scope cut.
- **Biggest risk:** the hand-written recovery is the highest-risk standard-library-only piece. Before it's used for signing it needs Wycheproof-style vectors plus a differential against ethers.

## Missing acceptance criteria

1. Integer encoding: U256 little-endian, u32/u64 big-endian, strict bool. Check against Rust-produced golden bytes.
2. Every index signed and durable before `index.json` advances (C1).
3. The `matching[required-1]` selection rule, with endpoints at mixed heights (C2).
4. An RPC-confirmed conflict writes a durable reorg flag and exits (H1).
5. Same signer halts; a different signer is overwritten (H2).
6. An unreadable or unparsable reorg flag blocks startup; the guard write retries forever; nothing is written after a halt (H3).
7. `v` normalisation, one-byte truncation, and where the EIP-191 wrap happens (H4).
8. Byte-exact JSON: field order, aliases, pretty vs compact, U256 format (H5).
9. RocksDB key layout, including the prefix collision and the write-ahead-log migration check (H6).
10. Relayer quorum builder: the poisoned-root case, Aleo padding, response order (H7).
11. URL de-duplication normalisation (H8).
12. A recorded preserve-or-fix decision for each lenient default (M1).
13. A per-method lander placeholder inventory (M6).
14. A scalable history design (M7).

## Parity tests

- **Golden encoding corpus:** Rust emits hex for every encode/decode type. Include U256 at 0, 1, 2^128 and max; bool bytes 0, 1, 2; u32/u64 edge values; Merkle insertions; gas payments. Zig must produce the same bytes and reject the same inputs.
- **Signature differential:** add the `ethers` feature to `zig/reference`. Test this matrix through both Rust and Zig and compare results and error classes:
  - `v` in {0, 1, 27, 28, 35+2c, 36+2c, 255}
  - high and low S
  - r = 0 and r ≥ curve order, s = 0, x ≥ curve order

  Also compare against OpenZeppelin `ECDSA.recover` running on anvil.

- **Validator trace replay:**
  - Feed scripted per-endpoint inputs to both: index, root, null or timeout, and response order.
  - On the Rust side, use the existing mock hook (`test_utils/mock_merkle_tree_hook.rs`); on the Zig side, the state machine.
  - Compare the set of signed indices, the published latest index, the readiness operations, and halt plus flag.
- **Storage readback:**
  - Rust writes a local checkpoint directory: checkpoints, index, snapshot, announcement and reorg flag.
  - Zig reads it, then the reverse, with a byte diff of the JSON.
  - Include a torn file, a directory where a file should be, an oversized file and an unparsable flag.
- **RocksDB golden database:** take a database from a Rust relayer run on the local end-to-end setup. Zig (via librocksdb) reads every prefix, Zig writes and Rust reads back, and the migration check runs in both directions.
- **Quorum builder:** fake storage with equivocation, same-root/different-ID poisoning, duplicate validators, missing storage, and an Aleo destination. Compare the metadata bytes produced.
- **URL de-duplication corpus:** host case, ports, trailing slash, userinfo and international domain names, compared with the Rust `url` crate.
- **Crash injection:**
  - Kill points: between signing and writing, between writing and `index.json`, and during the reorg-flag write.
  - Restart both implementations each time.
  - Expect identical disk state and never a second value at any index.
- **Mixed fleet:** Zig and Rust pointed at the same checkpoint location must fail closed.

## Unresolved questions

1. Is C2's identical-vote threshold an intentional hardening? If so, label it non-parity and measure the liveness cost.
2. For recovery strictness (C4), should Zig match ethers, or the on-chain ISM of each destination VM?
3. For the lenient defaults in M1, preserve or fix?
4. RocksDB: in-place compatibility via librocksdb, or a one-way migration? This decides whether rolling back to Rust is actually possible.
5. Who owns the per-method lander inventory (M6) and the history-capacity design (M7)?

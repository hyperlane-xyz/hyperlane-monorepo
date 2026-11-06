# Starknet adapter

Source-backed adapter library for `rust/main/chains/hyperlane-starknet` using the
production Starknet0.17 / Accounts0.16 / Core0.16 / Cainome0.10.1 wire contracts.
No production endpoint, credentials, transaction or deployment was used. This is
not a completed multi-VM agent service or a cutover claim.

`codec.Felt` rejects values outside the Stark field instead of reducing arbitrary
H256 inputs modulo the prime. JSON quantities serialize canonically. Selectors use
Starknet's 250-bit Keccak mask. Cairo U256 is low-u128 then high-u128. Hyperlane's
`Bytes` is size + array length + big-endian, right-padded u128 words; it is distinct
from Cairo ByteArray/31-byte short strings. Message fields, widths, zero bytes,
padding and truncation are validated. Announcements use the source's 31-byte ASCII
long-string chunks; unsupported strings fail rather than slicing UTF8 incorrectly.

`provider.Provider` borrows a shared `net/json_rpc.Client` with injected bounded
HTTP transport and explicit endpoint/header storage. It implements chain-ID checks,
latest confirmed block/nonce/call reads, historical block identity, fee-token U256
balances, class-hash existence, receipts, fee estimation, simulation and explicit
InvokeV3 submission. Error envelopes retain safe numeric codes and borrowed structured
data inside an owning wrapper; callers must deinit that wrapper. No URL/header/key
material or raw node error message is automatically logged.

`net/endpoint.zig` owns source-compatible custom-header/Basic extraction and
canonical URL identity. Raw IDN, legacy numeric IPv4 spellings and percent-encoded
hosts are explicitly unsupported for identity, preventing incorrectly distinct vote
slots. Its source-backed corpus covers case/default ports, literal and encoded dot
segments, repeated slashes, IPv6 and mapped IPv6. Never log the identity: it includes
the original URL's auth/header-query inputs as Rust Url equality does.

The shared HTTP transport requires HTTPS, verifies TLS and rejects redirects.
Production callers explicitly load/inject libcurl for actual total/connect deadlines
and cancellation; std HTTP remains a bounded fixture path without those wall-time
guarantees. Pool state is serialized per owner; concurrent jobs own separate clients
and retain borrowed endpoint/header storage until completion. Ordered fallback is
implemented; the Rust provider's background health/priority/metrics policy remains
a runtime integration concern.

Reorg `none` reads the latest confirmed height; `blocks(N)` subtracts saturating at
zero, preserving Rust. Reorg tags reject as unsupported. Accepted-on-L2 is distinct
from accepted-on-L1; a block/receipt being present does not imply L1 finality.
Checkpoint/count/tree queries can be pinned to an explicit block number, and
`countAndTip` resolves the height before querying count. Checkpoints deliberately
lack `message_id`; attach the actual indexed leaf before constructing a signable
protocol checkpoint. Merkle tree count/high bits and branch bounds reject overflow.

`contracts.Contracts` implements mailbox delivered/default/recipient ISM, nonce,
checkpoint/tree/count, process and delivered calls, announcement calls, announced
locations and module type/routing/multisig/aggregation queries. Process calls may be
batched by the account encoder; account execution is atomic, as in the source.
Contract/module addresses retain the full felt. Multisig validator addresses remain
Ethereum20 bytes and reject high bits. `contracts.Source(Origin)` uses the shared
metadata builder's `ModuleAddress` / `ModuleMembers` split; no truncation bridge.

The source ISM `dry_run_verify` currently returns an unconditional placeholder
`Some(1)` because verify is not an entrypoint. This implementation does not claim
that placeholder verifies metadata. Source requires an injected real verifier
(account/process simulation) and otherwise returns `StarknetDryRunUnavailable`.
Raw simulation returns an owned RPC envelope; callers must validate its trace and
execution result before treating it as successful. A JSON-RPC success alone is not
execution success.

`events.fetch` uses source-compatible getEvents filters/chunk size50 and bounded
pagination. It rejects repeated tokens, excessive pages/events, invalid ranges,
unconfirmed blocks, wrong contracts/topics and out-of-range events. It reconciles
events against successful transaction receipts and canonical block transaction
lists. Stable transaction indices come from the canonical block; stable log indices
come from receipt array positions. Duplicate pages do not generate duplicate event
identities. This intentionally strengthens Rust's zero transaction/log-index metadata.
Dispatch, Process/ProcessId, DispatchId and MerkleInsertion decode real Cairo layouts;
Dispatch's redundant indexed values must agree with its embedded message.

`transaction.Transaction` implements the source's modern and legacy account calldata
and InvokeV3 normal/query hashes, including L1/L2/L1-data resource bounds, tip,
empty paymaster/deployment data and L1 data-availability modes. JSON requests match
the actual SDK serializer semantically. The signer callback returns Stark-ECDSA r/s;
signatures verify against an explicitly pinned public key. Account address and signer
public key are separate concepts. The optional local signer wipes owned key copies.

`Provider.prepare` reads/checks chain ID, nonce, signed query fee estimation and
the latest block's median eligible V3 tip. It returns an unsigned production intent.
The mutation boundary remains explicit:

1. Persist the exact prepared account/nonce/calls/resources/chain signing intent.
2. Sign the non-query transaction through the injected signer.
3. Persist the signed request/hash before `Provider.broadcast`.
4. Reconcile that hash after an uncertain broadcast. Rebuilding/re-signing with
   another nonce is a separate durable decision.

Query versions cannot be broadcast. Submission revalidates the signed intent and
requires the returned transaction hash to equal the locally computed hash. The
library does not itself persist reservations, schedule retries or mark delivery.
Receipt finality and execution success remain separate. Source nonce/funding/receipt
polling and service orchestration still require runtime wiring.

Fee resource multiplication uses checked arithmetic. Padding defaults to exact
floor(x*3/2), representing the SDK's intended1.5 multiplier without large-integer
f64 rounding/saturating casts. Resource fee caps are explicit; the tip is separately
visible. Median averaging uses u128 so two large u64 tips do not wrap. These are
intentional safety differences. Older unsupported transaction versions fail closed.
SDK fee estimation permits absent unit and otherwise requires FRI, unlike generic
receipt fees which may be WEI or FRI; both are covered by SDK-generated fixtures.

Optional cryptographic dependency:

- No existing vetted C Starknet crypto implementation was present in this repo.
  Parent-approved `native-crypto` exposes six versioned C symbols for ABI version,
  Pedersen, Poseidon, public key, high-level deterministic signing and verification.
- It pins production `starknet-crypto0.8.1`, `starknet-core0.16.0`,
  `starknet-curve0.6.0` and `starknet-types-core0.2.4`. Its Cargo.lock was seeded
  from production to retain transitive versions; exact public lock bytes are stored
  in hook-safe `testing/locks.json` chunks, restored and SHA-256 checked by
  `testing/locked.py` before locked builds; `secret-felt`/zeroize protects
  owned scalar copies. This is a remaining **third-party Rust crypto dependency**,
  not a zero-dependency or all-Rust-eliminated claim.
- The C ABI has fixed big-endian buffers, field/scalar/null/count validation,
  panic containment and fixed error codes. It exposes no network, runtime,
  transaction policy, random-nonce API or credential discovery. No custom Stark
  curve/Pedersen/Poseidon implementation was added.
- This host's locked release build has94 package entries and a stripped602KiB
  macOS dylib; platform sizes/build times vary. Build it explicitly and include its
  dependencies/build cost in whole-system comparisons. Default Zig tests do not
  load it. All jobs must finish before unloading the library.

```sh
python3 zig/src/starknet/testing/locked.py --toolchain 1.98.0
HYPERLANE_STARKNET_CRYPTO_LIBRARY="$PWD/zig/src/starknet/native-crypto/target/release/libziggy_starknet_crypto.dylib" zig test zig/src/root.zig -target aarch64-macos.15.0 -lc --test-filter Starknet
```

Linux produces `libziggy_starknet_crypto.so`. The compiler/SDK shim in `zig/tools`
handles host-specific build setup; native libraries are explicit inputs.

Oracle `testing/reference` regenerates bindings from the checked-in production
ABI with the same Abigen options; it does not require ignored generated sources.
It uses actual SDK account encoding/hashing/serde/signing and independently emits
34 chunked records:13 messages,14 invokes,7 typed RPC header/receipt/events/fee wires.
Only public fixture scalar17 is used; no network RPC or on-chain account execution occurs. Tests
compare exact felts/hashes/signatures, semantic JSON, body boundaries, canonical
event identity, duplicate pages, malformed data, address width and source placeholders.

```sh
python3 zig/src/starknet/testing/regenerate.py --check
cargo +1.98.0 clippy --locked --release --manifest-path zig/src/starknet/native-crypto/Cargo.toml --all-targets -- -D warnings
```

Remaining source/factory gaps are explicit: the Rust IGP is a zero-address placeholder
and rejects configured nonzero IGP indexing; application operation verification is a
no-op; source Lander/factory support and delivered-calldata were incomplete. Zig
provides the concrete delivered call and read-only scraper factory; relayer/validator
service factories, validator supervisor and production simulation verifier remain. RPC schemas
are pinned to the source SDK, not advertised as every historical Starknet RPC version.
No throughput or service-completion claim follows from these fixture results.

`agents/scraper/starknet.zig` provides a concrete typed-settings factory and Source.
It owns normalized RPC endpoints, pins sequence counters to the canonical block
hash, and derives event positions from successful receipts and block transaction
lists. Actual SDK JSON fixtures run through a disposable HTTP server. Native
cryptography is not needed for these read-only scraper operations. Nonzero IGP
configuration rejects because the production Starknet IGP implementation remains
a placeholder; safe/finalized tag indexing is unsupported.

# Tron adapter

Source-backed adapter library for `rust/main/chains/hyperlane-tron` and
`rust/main/lander/src/adapter/chains/tron`. It has no live-network or private-key
test dependency. This is not a completed agent service or deployment cutover.

The checked-out Rust adapter uses **HTTP**, despite Tron also offering gRPC:

| Configured pool        | Existing path/method                                         | Zig behavior                                                                           |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `wallet_urls`          | `/estimateenergy`, `/broadcasthex`                           | Energy estimation and exact signed protobuf submission                                 |
| `wallet_solidity_urls` | `/getnowblock`, `/getblockbynum`, `/triggerconstantcontract` | Solidified height, canonical historical block IDs and latest solidified contract state |
| `rpc_urls`             | Ethereum JSON-RPC                                            | Logs, transaction receipts, energy price, balance and contract code                    |

`Provider.init(allocator, transport, Config)` borrows its three endpoint/header
arrays. Each pool is ordered fallback; malformed typed wallet responses fail over
before being returned. Errors contain fixed names rather than provider URLs,
API-key query values, node error payloads, signatures or request bodies.
`net/endpoint.zig`'s `OwnedEndpoint.parse` extracts the source's `custom_rpc_header` query entries,
applies case-insensitive last-header-wins behavior, removes malformed no-colon
entries, and preserves other query pairs/order with form encoding. It also converts
URL userinfo into a Basic header before transport. Simultaneous URL Basic and custom
Authorization reject as ambiguous. Keep owned endpoints alive until all jobs finish.
Raw `rpc.Endpoint` accepts an already sanitized URL and explicit headers.

`cloud.http.Transport` injects bounded HTTP behavior. The standard implementation
requires HTTPS (explicit literal loopback opt-in for tests), disables redirects,
checks TLS and bounds response bytes. Production callers explicitly inject
`HttpTransport.native_curl` for actual DNS/connect/body deadlines and cancellation.
The native dependency is the shared libcurl adapter, not a copied Tron HTTP stack.
Pools and providers have one serialized owner; concurrent jobs own separate state.
Endpoint health/deprioritization and whole-operation budgeting belong to the runtime;
the Rust fallback provider's background stall probes and priority metrics are not
reimplemented by this ordered fallback pool.

`Provider.call` returns the first `constant_result`, including an empty result or
revert bytes, ahead of a node's `result.code`. This preserves the actual CCIP-read
contract. No result and nonpositive energy estimates fail. Latest/finalized ABI
calls use walletsolidity; numbered/safe historical calls return unsupported.
`Contracts.offchainVerifyInfo` returns raw OffchainLookup bytes directly, avoiding
Rust's error-string/regex bridge.

`Contracts` implements mailbox delivered/default/recipient ISM and nonce, hook
count/checkpoint/tree, process calldata, announcements and storage-location reads,
and module type/routing/multisig/aggregation queries. The checkpoint return type
deliberately lacks `message_id`: callers must attach the actual indexed leaf before
constructing a signable `protocol.Checkpoint`. Count precedes finalized-tip reads,
as in Rust. Neither that ordering nor a wallet response pins state to a historical
height; the source's `latest_checkpoint_at_block` fabricates the requested height
despite reading current state, and Zig does not reproduce that attribution.

`Contracts.Source(Origin)` implements the shared metadata builder's source interface
with an injected origin/checkpoint/proof source. Dry-run verification preserves
TrustedRelayer/RateLimited Null ISM special cases, routing iteration and recursive
aggregation metadata slicing, with a cumulative 100-node and 10-level budget.
Unsupported metadata types remain explicit errors from the shared builder; this
module does not make every ISM implemented by the wider system available.

`Provider.logs` only indexes ranges at/below walletsolidity's current height.
It validates all event addresses, topics, quantities, inclusive ranges and removed
flags; decodes real Dispatch/Process/IGP/MerkleInsertion ABIs; and checks each block's
JSON-RPC log hash against walletsolidity's canonical block ID. Dispatch logs sort
by packed message nonce as in Rust. Duplicate events are retained for the durable
indexer's own event-identity deduplication. The adapter does not advance a cursor.

Transactions use the shared `altvm.tron` protobuf encoder. TAPOS bytes are the low
16 bits of the block number, reference hash bytes 8–15, and the raw protobuf also
includes `ref_block_num`, matching the checked-out source. Timestamp precision is
whole seconds and the default lifetime is 60 seconds. TXID is SHA256(raw_data),
signed directly without EIP-191. The signature wire uses v27/28, matching ethers.

The new independent oracle caught a genuine previous wire mismatch:
`Any::from_msg` produces `/protocol.TriggerSmartContract`; the earlier Zig encoder
and manually specified reference had used `type.googleapis.com/...`. The shared
encoder/reference were corrected, changing all affected raw bytes and txids.

`transaction.FeePolicy` defaults to exact 3/2 multiplication, supports explicit
source-compatible `f64 energy_multiplier`, and checks multiplication/conversion
and configured fee caps. Rust saturates U256 multiplication, truncates to low u64,
uses f64 and then casts to i64. Zig intentionally rejects overflow, negative/NaN
or infinite multipliers and fees beyond i64 rather than emitting wrapped limits.
All other wire signed-integer fields reject values above i64 maximum.

The mutation boundary is explicit:

1. `Provider.prepare` reads energy, price and solidified TAPOS and returns owned
   `transaction.Unsigned`, preserving a supplied energy floor.
2. Runtime persists the exact signing intent/reservation before `transaction.sign`.
   The injected signer receives only a raw digest; local, AWS KMS and GCP KMS can
   implement the callback. Recovered signatures must match the transaction owner.
3. Runtime persists owned signed bytes and txid before `Provider.broadcast`.
   Broadcast validates the signed envelope and expiry, never rebuilds/re-signs.
4. Runtime reconciles the same txid after an uncertain broadcast, and explicitly
   decides when to prepare a fresh transaction after expiry/resubmission delay.

The library does not itself persist these reservations. No API combines signing
and broadcasting behind a retry loop. `transaction.decodeRaw/decodeSigned` borrow
input, reject duplicate fields, incorrect contract/Any types, invalid TAPOS,
unexpected permissions/contracts/token transfers, truncated bytes and wrong signers.
The source builds token fields as zero; these decoders explicitly reject unsupported
nonzero token fields instead of interpreting them as ordinary mailbox calls.

`Provider.receipt` checks the returned txid and typed inclusion/hash/status fields.
`Provider.status` reports pending/expired/included/finalized and verifies canonical
block identity at finality. Finality is distinct from receipt execution success:
callers must inspect `Receipt.success` and the delivery success criterion before
marking a payload delivered. `transaction.classify` maps the source's exact node
codes, including duplicate, permanent TAPOS/signature/expiry errors and the source's
spelled `BANDWITH_ERROR` resource-cap condition. The resubmission helper preserves
the estimated 18-block delay. Polling/scheduling, chain metrics and retry decisions
are external.

Oracle provenance and tests:

- `zig/reference/tron` pins actual `tron-rs 0.1.0`/`prost 0.13.4`, uses
  `Any::from_msg`, SHA256 and independent k256 fixture signing. Only the public
  repeated-0x11 fixture key is used. `fixtures/transactions-agent.jsonl` has 16
  chain-admissible timing/source-token cases: scalar/varint/i64 boundaries and
  data lengths 0/1/55/56/127/128/255/256/4096, both signature parities.
- `fixtures/transactions.jsonl` retains 16 broader raw protobuf wire cases with
  token fields and zero/equal timing; those are not all source-supported broadcast
  inputs. Raw syntactic validity must not be mistaken for transaction admissibility.
- `fixtures/http.jsonl` has 11 wires generated by importing the actual production
  HTTP serde structs, including missing optional fields, defaults and exact trigger
  serialization. Fixtures chunk long hex/UTF8 strings; concatenate before use.
- Exact raw/signed bytes, txids, independent signatures, decoded fields and every
  signed-wire truncation pass. Real std/native HTTP loopback validates the actual
  trigger request/body and energy response. Scripted lifecycle, finality, canonical
  logs, malformed shapes/ABIs, nested locations and routing-cycle tests pass.

Regenerate from repository root:

```sh
python3 zig/src/tron/testing/regenerate.py --check --toolchain 1.98.0
HYPERLANE_CLOUD_CURL_LIBRARY=/usr/lib/libcurl.4.dylib zig test zig/src/root.zig -target aarch64-macos.15.0 -lc --test-filter Tron
```

Drop `--check` to regenerate the three fixture files from the same oracle output.
There is no full Tron agent CLI/config factory, on-disk legacy Lander precursor
serde migration, network-backed scraper sink or long-running validator integration
in this module. The Rust Lander `estimate_gas_limit` itself is `todo!`; the Zig
energy estimator is real, but the shared runtime factory must wire it. No production
endpoint, credential, broadcast or deployment was touched, and no speedup is claimed.

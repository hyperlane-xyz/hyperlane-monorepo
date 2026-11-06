# Zig Lander runtime

Native, durable EVM Lander service with a chain-neutral scheduler boundary. AltVM drivers remain outside this delegation.

## Parent integration

Import `zig/src/lander/root.zig`. The parent retains ownership of the RocksDB handle, RPC client, native curl client, chain/domain settings, signer implementation, and cancellation token.

```zig
const lander = @import("lander/root.zig");
const rocks = @import("../db/rocks.zig");
const evm_provider = @import("../evm/provider.zig");

var store = lander.Store.init(&database, chain.name);
var evm = lander.evm.Evm{
    .rpc = &rpc_client,
    .reorg = chain.reorg,
};
var service = try lander.Service.open(
    allocator,
    store,
    evm.interface(),
    .{
        .domain_name = chain.name,
        .chain_id = chain_id_u256,
        .signer = digest_signer,
        .overrides = chain.connection.ethereum.transaction_overrides,
        .max_batch_size = chain.max_batch_size,
        .batch_contract_address = chain.batch_contract_address,
        .bypass_batch_simulation = chain.bypass_batch_simulation,
        .max_submit_queue_length = chain.max_submit_queue_length,
        .mev_submission = mev_submission,
        .zksync_stack = is_zksync_stack,
        .observer = observer,
        .arbitrum_nitro = is_arbitrum_nitro,
        .estimated_block_time_ms = block_time_ms,
    },
    &cancel_atomic_bool,
);
defer service.deinit();
```

`Signer` contains an address and a digest callback returning a 65-byte Ethereum signature with `v=27/28`. Use the existing KMS/local signer adapters to implement it. The service recovers and compares the configured address before persistence or broadcast. It never discovers credentials or prints endpoint/header values.

`Evm` requires `RpcClient.Options.native_transport` unless `allow_std_fixture` is explicitly enabled for loopback tests. Configure RPC timeout, connect timeout, response limits, and the same stable cancellation pointer used by `Service`.

### Enqueue and tick

```zig
const result = try service.enqueue(.{
    .payload = .{
        .uuid = payload_uuid,
        .metadata = message_id_or_other_safe_metadata,
        .data_json = serialized_typed_transaction_and_function_json,
        .gas_limit = prepared_gas_floor,
        .success_criteria_json = optional_serialized_check_and_function_json,
        .to = mailbox_or_other_h256,
        .value = null,
    },
    .delivery = .{ .mailbox_message = message_id },
});
_ = result;

const report = try service.tick(now_ms, .{
    .max_transactions = 16,
    .max_receipts = 32,
    .max_build = 4,
    .max_payload_scan = 64,
    .max_reorg = 64,
});
```

`data_json` is the Rust-compatible JSON byte serialization of `(TypedTransaction, Function)`. `success_criteria_json` has the same shape and is evaluated as an `eth_call` returning ABI bool. Delivery options:

- `.none`: no sidecar proof. Canonical `success_criteria_json`, if present, is still enforced. Without a criterion, finalization matches Rust and needs no separate payload proof; stale recovery cannot claim independent delivery.
- `.mailbox_message`: calls `Mailbox.delivered(bytes32)` using the payload's H256 `to` address.
- `.contract`: calls the supplied address/calldata and ABI-decodes bool.

Enqueue inputs are borrowed and copied before return. Tick reports contain counts only; no RPC messages, URLs, keys, or credentials. Canonical transaction/payload records can be read through `Store.loadTransaction`, `loadPayload`, and index helpers when the relayer worker needs detailed outcomes.

## Durability and Rust compatibility

Canonical records use the existing domain-scoped RocksDB keys and serde JSON:

- `payload_by_uuid_`, payload indexes and pending projection.
- `transaction_by_uuid_`, transaction indexes and H512 hash history.
- Finalized/upper/reorg nonces, nonce-to-UUID and reverse mappings with Rust little-endian u256 and nil/max sentinels.

No migration deletes or rewrites outstanding Rust nonce state. Legacy finalized-presence fallback and missing payload `gas_limit` are supported. Additive versioned keys are:

- `zig_lander_signed_attempt_by_uuid_hash_v1_`: exact signed bytes and nonce per transaction/hash.
- `zig_lander_delivery_by_payload_uuid_v1_`: optional native delivery metadata not representable in Rust `FullPayload`.
- `zig_lander_nonce_availability_generation_v1_`: atomic dropped-status generation used to invalidate bounded nonce-scan cursors when availability changes.
- `zig_lander_active_tx_by_index_v1_` and `zig_lander_active_tx_checkpoint_v1_`: active-only recovery after a complete canonical-history migration.
- `zig_lander_finalized_receipt_by_uuid_hash_v1_`: typed winning-receipt accounting data keyed by UUID16 + full native hash32. `Store.loadFinalizedReceipt` returns `!?FinalizedReceipt`; the value owns no allocations.

Payload/index writes, transaction build + payload association, nonce mappings, signed attempt + mutated transaction, and terminal transaction + payload outcomes use synchronized atomic RocksDB batches. Finalized status, payload outcomes, and the `FinalizedReceipt` projection share one `commitSync`; nonfinal/reorg writes invalidate every projection for that UUID in their status batch. Signed bytes and their hash are durable **before** `eth_sendRawTransaction`. A lost response leaves a pending attempt that is reconciled before another submission. Same-fee retries reload identical bytes; replacements retain every hash and exact attempt.

Startup behavior:

1. Clear only the derived pending-payload projection and rebuild it from canonical payloads in bounded pages. Building waits for completion.
2. After a complete migration checkpoint, replay only active transactions; otherwise page all transaction indexes. Reconcile signed attempts/receipts and stale-drop already-resolved transactions before allowing new nonce reservations.
3. Refresh the finalized account nonce. Allocation and boundary changes share one mutex. Bounded nonce scans resume and never skip an unscanned gap.
4. Persist nonce regressions before boundary changes. A reorg range is cleared only after all entries are reprocessed.

Receipts are accepted only after transaction identity and canonical block-hash checks. Configured confirmations/finalized tag determine finality. Execution status does not decide payload success. Included payload checks use current head; finalized checks use finalized height. A reverted execution can finalize and consume a nonce while its payload becomes `Dropped(Reverted)`. The durable projection retains the actual winning hash, canonical block number/hash, execution flag, gas used, and optional effective gas price. Missing gas data fails closed; an authoritative zero price is valid. Root maps this record to `agents/relayer/evm_accounting.ProjectedReceipt`, with authenticated RPC retained as the migration fallback.

## Source oracles

`testing/reference` includes unchanged production Rust source for the Lander escalator, payload types, transaction types, and Ethereum precursor. It also calls pinned `ethers_core::utils::eip1559_default_estimator` directly. The canonical `fixtures/lander_types.json.gz` is consumed by `lander/tests.zig`; isolated regeneration is compared before replacing it.

```bash
python3 zig/tools/fixture_pack.py restore-locks
cd zig/src/lander/testing/reference
ZIGGY_LANDER_FIXTURE_OUTPUT=/tmp/ziggy-lander-types-candidate.json cargo +1.98.0 run --locked --offline --bin lander-escalator-oracle -j 2
cargo +1.98.0 run --locked --offline --bin multicall -j 2
cargo +1.98.0 run --locked --offline --bin eip2930 -j 2
```

The oracle covers six escalator vectors, three ethers estimator vectors, and production JSON round-trips. The exact standalone lock is preserved as `Cargo.lock.gz`, verified and restored by the command above; only its generated raw mirror and compiler outputs are ignored. This is a newly recovered helper graph seeded from the immutable production lock, not a recovered historical lock: all 325 external package version/source/checksum identities match production. The standalone manifest applies the same production numeric/RLP git patches and retains the exact ethers revision. Offline locked metadata and the separately approved three-binary build pass. The regenerated 2,090-byte type golden matched the preserved canonical bytes exactly; six escalator vectors, three ethers estimator vectors, JSON round-trips, twelve EIP-2930 fields and four multicall cases passed. Source and canonical raw/gzip hashes remained unchanged; `zig/bench/results/lander-golden-recovery/result.json` records this functional check.

See `docs/zig-agent-rewrite/helper-locks.md` for reproducible isolated build/run/byte-diff commands; these never replace the canonical golden before comparison.

## Native tests

Use Zig 0.15.2 and the macOS 15.4 SDK. The six archives match `zig/bench/results/native-db-test-command.json`.

```bash
/tmp/ziggy-toolchain/zig-aarch64-macos-0.15.2/zig test \
  zig/src/lander_delegated_tests.zig -O ReleaseSafe \
  -lc -lc++ --sysroot /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk \
  -L/usr/lib \
  -I/Users/pbio/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/librocksdb-sys-0.17.3+10.4.2/rocksdb/include \
  zig/native/rocks/abi.cc \
  rust/main/target/release/build/librocksdb-sys-e9e273bf61e48040/out/librocksdb.a \
  rust/main/target/release/build/librocksdb-sys-e9e273bf61e48040/out/libsnappy.a \
  rust/main/target/release/build/zstd-sys-aa8fc3ea64e8bbd6/out/libzstd.a \
  rust/main/target/release/build/lz4-sys-1c560f68511faa38/out/liblz4.a \
  rust/main/target/release/build/bzip2-sys-a5fc0982b4bd0f7f/out/lib/libbz2.a \
  rust/main/target/release/build/libz-sys-99bbd62b9b10c5ab/out/lib/libz.a \
  -j2
```

The delegated entry file is removed at handoff. Parent should import `lander/tests.zig`, `lander/http_tests.zig`, `lander/anvil_tests.zig`, and `evm/eip2930.zig` from its owned test root without changing shared files in this delegation.

Latest delegated run: **110 passed, 12 skipped, 0 failed** (122 discovered). Coverage includes committed nonce 0, freed/missing nonce reuse, association conflicts, concurrent boundary/allocation, resumable scans, reservation recovery, same-byte retry, timeout-after-accepted-broadcast, all replacement hashes, canonical/finalized receipts, restart persistence, reorg winner replacement, missing-gas rejection, optional-fee encoding, owned drop reasons, exact post-`getOrPut` allocation failure, payload reversion, stale recovery, pending-index rebuild, queue limits, gas caps/order/saturation, and Rust serde fixtures. Tests use only the public `@splat(0x11)` key and mock chains.

## EVM scope and evidence boundaries

Implemented: Multicall3 construction/fallback/simulation, MEV/ICA protected routing, zkSync estimation, EIP-2930, active-checkpoint recovery, aged inclusion backoff, source metrics/observer events, and winning-receipt payload outcomes. See `PARENT_API.md` for exact integration fields and callback contracts.

- AltVM drivers remain owned by Scope/Protocol and are outside this delegation.
- Native DB, loopback JSON-RPC, and a real local Anvil Multicall3 deployment are tested. Production RPC and real keys are not used.
- No production-network test, live production transaction, or performance benchmark is claimed.
- Parent-owned root integration and the proposed shared transaction-union change are not patched here; the Lander-owned request union already supports EIP-2930 end to end.

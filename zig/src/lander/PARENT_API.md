# Parent integration contract

Import `zig/src/lander/root.zig`. Root retains settings, providers, shared operations, and test-root ownership. This delegation does not modify those files.

## Service configuration

`Config` fields added since the 40-test checkpoint:

```zig
.max_batch_size = chain.max_batch_size,
.batch_contract_address = chain.batch_contract_address,
.bypass_batch_simulation = chain.bypass_batch_simulation,
.mev_submission = mev_submission,
.zksync_stack = is_zksync_stack,
.observer = observer,
```

Existing fields remain `domain_name`, `chain_id`, `signer`, `overrides`, `max_submit_queue_length`, `arbitrum_nitro`, and `estimated_block_time_ms`.

`max_batch_size == 0`, empty domain, zero block time, or zero MEV timeout is rejected. `max_batch_size > 1` uses the real Multicall3 path and requires `batch_contract_address` with deployed code at tick time. Construction failure, missing code, or floor-cap rejection falls back to independent transaction UUIDs.

## MEV configuration

`mev_submission` is nullable. Null means ordinary public submission only.

```zig
const mev_submission: ?lander.MevSubmission = .{
    .policy = .{
        .mailbox = chain.contracts.mailbox[12..32].*,
        .ica_router = ethereum_mev.ica_router,
        .additional_ica_routers = ethereum_mev.additional_ica_routers,
    },
    .protected_chain = protected_evm.interface(),
    .timeout_ms = 5_000,
};
```

`protected_chain` must be independently configured with the private RPC endpoints, bounded DNS/connect/read deadlines, cancellation, and the same signer identity. Public chain ID, fee history, account nonce, and receipt/finality reads use the ordinary `Chain`. Protected simulation, gas estimation (including zkSync), and raw broadcast use `protected_chain` whenever any original payload is an ICA reveal. Errors never fall back to public broadcast.

The policy matches exactly: transaction recipient is the configured mailbox, function is `process`, ABI args are two byte strings, packed message recipient is the primary/additional ICA router, and packed body starts with byte `2`. One match protects a mixed batch.

## Chain additions

`Chain` now requires:

```zig
.get_code_fn = getCode, // only called for Multicall construction
```

For zkSync chains, also set:

```zig
.zks_estimate_fee_fn = zksEstimateFee, // nullable otherwise
```

`Receipt` adds:

```zig
.gas_used: ?u256 = null,
.effective_gas_price: ?u256 = null,
.executed: bool = true,
```

`Call` adds:

```zig
.value: u256 = 0, // aggregate3Value msg.value; ordinary calls remain zero
```

`types.Request` supports `.legacy`, `.eip2930`, and `.eip1559`. `zig/src/evm/eip2930.zig` supplies the concrete RLP/signing variant; the shared `evm/transaction.zig` union was not edited.

## Observer

`observer` is nullable. Null preserves previous behavior.

```zig
const obs: lander.Observer = .{
    .context = root_observer_context,
    .metric_fn = rootMetric,
    .finalized_fn = rootFinalizedOutcome,
};
```

Metric events cover submissions, finalization, dropped payloads/transactions, batch success/failure, MEV success/error, status batches and avoided requests, queue/pool lengths, task liveness by stage, oldest unchecked age, scan duration, inclusion errors, call retries, finalized/upper/mismatched nonce, and precursor fee/gas values. Metric callback errors do not alter lifecycle behavior.

`FinalizedOutcome` contains:

- `outcome_id`: Keccak transaction UUID + winning hash; root must deduplicate expenditure on this key.
- `transaction_uuid` and actual canonical `winning_hash`, not the latest signed attempt.
- `executed`, `gas_used`, and `effective_gas_price` from that receipt.
- `total_estimated_gas` and per-payload `{uuid, delivered, estimated_gas}` for batch allocation.

The callback runs after payload outcome evaluation and before terminal transaction persistence, matching `post_finalized` ordering. It borrows all slices. Copy retained values and deduplicate on `outcome_id` so a DB failure/retry cannot double-charge expenditure.

## Durable recovery additions

Versioned sidecars, in addition to signed attempts, delivery metadata, and nonce availability generation:

- `zig_lander_active_tx_by_index_v1_`: atomically maintained active transaction index.
- `zig_lander_active_tx_checkpoint_v1_`: permits active-only startup replay after complete migration.

Startup without a checkpoint performs canonical history recovery. Later startups replay only active records. A checkpoint is committed only when no partial/error receipt pages remain. New builds and nonce allocation remain gated until recovery completes.

## Durable finalized-receipt projection

`Store.loadFinalizedReceipt(allocator, transaction_uuid, transaction_hash)` returns `!?FinalizedReceipt`. The caller supplies the full 32-byte winning native hash; a missing record returns `null`, and malformed/version-mismatched records fail closed. The returned value owns no allocations.

```zig
pub const FinalizedReceipt = struct {
    version: u8 = 1,
    transaction_uuid: [16]u8,
    transaction_hash: [32]u8,
    block_number: u64,
    block_hash: [32]u8,
    executed: bool,
    gas_used: u256,
    effective_gas_price: ?u256,
};
```

The key is `zig_lander_finalized_receipt_by_uuid_hash_v1_` + UUID16 + full winning hash32. The binary value is 123 bytes without an effective gas price or 155 bytes with one: version, UUID, winning hash, big-endian block number, canonical block hash, execution flag, little-endian u256 gas used, fee-presence byte, and optional little-endian u256 effective gas price. Authoritative zero prices are retained; missing gas-used data prevents finalization instead of fabricating zero.

Finalized transaction status, payload outcomes, and this projection commit in one destination `TypedBatch.commitSync`. Every nonfinal transaction/submission write deletes all projections for that UUID in the same synchronized batch. A replacement finality proof writes only the new winner after removing the old winner, so stale hashes cannot overwrite current accounting data.

Root can adapt the projection directly to `agents/relayer/evm_accounting.ProjectedReceipt`:

```zig
return .{
    .block_number = receipt.block_number,
    .block_hash = receipt.block_hash,
    .gas_used = receipt.gas_used,
    .effective_gas_price = receipt.effective_gas_price,
    .executed = receipt.executed,
};
```

The existing authenticated RPC path remains the migration fallback for records finalized before this sidecar existed.

## Store ownership and allocation safety

`Store.transactionStatus` returns `?OwnedStatus`. Call `owned.deinit(allocator)` exactly once. For `Dropped(Other)`, `owned.value.dropped.other` points to `owned.reason`, not to the temporary JSON record; it remains valid after `Store.loadTransaction` results are destroyed and until `OwnedStatus.deinit`.

Receipt pagination initializes a newly inserted `ReceiptProgress` to an empty slice immediately after `getOrPut`, before allocating its items. An item-allocation failure therefore leaves a valid reusable empty entry rather than undefined memory. The in-module regression forces this exact allocation boundary after pre-reserving map capacity, verifies the empty entry, reuses it successfully, and destroys it safely.

## Root test integration

Import these test modules from the parent-owned test root:

- `lander/tests.zig`
- `lander/http_tests.zig`
- `lander/anvil_tests.zig`
- `evm/eip2930.zig`

The Anvil test uses `/Users/pbio/.foundry/bin/anvil` and skips if it cannot spawn. It deploys the production Multicall3 transaction from Rust source and verifies positional `allowFailure` results locally. No production RPC or real signing key is used.

# Fast Relay Phase 2: Message Extraction Implementation Notes

## Current Status

Phase 1 is complete with:
- Job storage infrastructure
- HTTP endpoints (POST /fast_relay, GET /fast_relay/:id)
- Rate limiting
- Integration with relayer startup

Phase 2 adds message extraction from transaction receipts.

## Implementation Progress

### ✓ Event Extractor Module Created

Created `rust/main/agents/relayer/src/fast_relay/extractor.rs` with:
- `extract_hyperlane_message()` function
- Reuses existing `fetch_raw_logs_and_meta()` from hyperlane-ethereum
- Extracts Dispatch events and parses HyperlaneMessage
- Returns `ExtractedMessage` with message, message_id, and tx_hash

### ⚠️ Provider Access Challenge

The extractor needs:
1. **Provider** (Arc<M: Middleware>) - to fetch transaction receipts via RPC
2. **Mailbox address** - to filter Dispatch events

**Current server state** (in `rust/main/agents/relayer/src/server/mod.rs`) has access to:
- `dbs: HashMap<u32, HyperlaneRocksDB>` - databases
- `gas_enforcers` - gas payment enforcers
- `msg_ctxs` - message contexts (origin-destination pairs)
- `prover_syncs` - merkle tree builders

**What's missing**: Direct access to providers for arbitrary origin chains.

## Options for Provider Access

### Option 1: Pass Origins HashMap to Server (Recommended)

Modify `Server` struct to include origins:
```rust
pub struct Server {
    // ... existing fields ...
    #[new(default)]
    origins: Option<HashMap<HyperlaneDomain, Origin>>,
}
```

Then in `fast_relay/create_job.rs`, look up the origin by chain name and access its `chain_conf` to build a provider.

**Pros**: Origins already contain all chain configuration
**Cons**: Need to build provider from ChainConf at request time

### Option 2: Pass Provider Registry

Create a new `ProviderRegistry` type:
```rust
pub struct ProviderRegistry {
    providers: HashMap<String, Arc<dyn Middleware>>,
    mailbox_addresses: HashMap<String, ethers::types::H160>,
}
```

**Pros**: Providers are pre-built and ready to use
**Cons**: Requires new abstraction layer

### Option 3: Use MessageContext

MessageContext has `origin_db` which could theoretically be extended to include provider access.

**Pros**: Reuses existing structures
**Cons**: MessageContext is per origin-destination pair, not per origin

## Recommended Implementation Path

1. **Short term**: Add provider registry to Server (Option 2)
   - Build it in `relayer.rs::build_router()` from origins
   - Simple HashMap lookup by chain name
   - Clean separation of concerns

2. **Medium term**: Integrate CCTP event extraction
   - Add CCTP MessageTransmitter ABI generation
   - Create `extract_cctp_message()` function
   - Include CCTP attestation hash in ExtractedMessage

3. **Long term**: Consider making this async/background
   - RPC calls can be slow (200-1000ms)
   - Current implementation blocks the HTTP request
   - Could spawn extraction as background task and return job_id immediately

## Current Implementation Status

The extractor module is ready but commented out in the endpoint handler until provider access is resolved. Search for `// TODO: Phase 2` in:
- `rust/main/agents/relayer/src/server/fast_relay/create_job.rs`

## Testing Strategy

Once providers are wired up:

1. **Unit tests**: Mock provider returning test receipts
2. **Integration test**: Use local anvil chains
3. **E2E test**: Real CCTP transfer on testnet

Sample test flow:
```bash
# 1. Deploy warp route on local chains
# 2. Send a CCTP transfer
# 3. Capture tx_hash from step 2
# 4. POST /fast_relay with tx_hash
# 5. Verify message_id is extracted correctly
# 6. Verify relay completes faster than normal path
```

## Files Modified

- `rust/main/agents/relayer/src/fast_relay/extractor.rs` (NEW)
- `rust/main/agents/relayer/src/fast_relay/mod.rs` (exports extractor)
- `rust/main/agents/relayer/src/server/fast_relay/create_job.rs` (TODO added)

## Next Steps

Decide on provider access strategy and implement Option 2 (Provider Registry).

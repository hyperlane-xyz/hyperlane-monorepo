# Relay API Setup Guide

## Current Implementation Status

✅ **Infrastructure Complete** (Phases 1-3)
- API endpoints fully implemented
- Protocol-agnostic design
- Message injection working
- All wiring in place

⚠️ **Needs Configuration** (Phase 4)
- ProviderRegistry needs to be populated with chain indexers
- Currently only EVM implementation exists

## Quick Start (EVM Chains Only)

### Step 1: Enable the Feature

```bash
# Enable the relay API
export HYPERLANE_RELAYER_RELAY_API_ENABLED=true

# Optional: Disable normal indexing (for isolated testing)
export HYPERLANE_RELAYER_DISABLE_INDEXING=true
```

**Note**: `HYPERLANE_RELAYER_DISABLE_INDEXING=true` disables all contract sync and db loader tasks, allowing you to test the relay API endpoints in isolation. Remove this flag for production use.

### Step 2: Wire Up the ProviderRegistry

**Current limitation**: The ProviderRegistry is empty by default. You need to populate it with mailbox indexers for each origin chain during relayer startup.

#### Pattern for EVM Chains

Add this logic in `relayer.rs` in the `run()` method, after origins are created:

```rust
// Build ProviderRegistry for relay API
let relay_api_enabled = env::var("HYPERLANE_RELAYER_RELAY_API_ENABLED")
    .is_ok_and(|v| v == "true");

let provider_registry = if relay_api_enabled {
    use crate::relay_api::{EvmMailboxIndexer, RegistryBuilder};
    use hyperlane_ethereum::EthereumMailboxIndexer;
    use hyperlane_core::HyperlaneDomainProtocol;

    let mut builder = RegistryBuilder::new();

    for (domain, origin) in &self.origins {
        // Only EVM chains are supported currently
        if domain.domain_protocol() == HyperlaneDomainProtocol::Ethereum {
            // Extract the mailbox indexer from origin.message_sync
            // Note: This requires downcasting the ContractSyncer trait object
            // See example below for full implementation

            // For now, log that EVM chain is detected
            info!("Relay API: EVM chain detected: {}", domain.name());
        }
    }

    Some(builder.build())
} else {
    None
};
```

### Step 3: Pass Registry to Server

In `build_router()`, pass the registry to the ServerState:

```rust
if let (Some(job_store), Some(send_channels)) = (self.relay_job_store, self.relay_send_channels) {
    let relay_worker = Arc::new(crate::relay_api::RelayWorker::new(
        send_channels,
        self.msg_ctxs.clone(),
        job_store.clone(),
    ));

    let mut relay_state = crate::relay_api::handlers::ServerState::new(job_store)
        .with_relay_worker(relay_worker);

    // Add provider registry if available
    if let Some(registry) = provider_registry {
        relay_state = relay_state.with_provider_registry(registry);
    }

    router = router.merge(relay_state.router());
}
```

## Protocol Support

### Currently Implemented

| Protocol | Status | Implementation |
|----------|--------|----------------|
| **EVM** | ✅ **Ready** | [EvmMailboxIndexer](src/relay_api/evm_indexer.rs) |
| Cosmos | ⚠️ **Needs Implementation** | Trait defined, no impl |
| Sealevel | ⚠️ **Needs Implementation** | Trait defined, no impl |
| Others | ⚠️ **Needs Implementation** | Trait defined, no impl |

### Adding New Protocol Support

To add support for a new protocol (e.g., Cosmos, Sealevel):

1. Create a new indexer file (e.g., `cosmos_indexer.rs`)
2. Implement the `MailboxIndexer` trait:

```rust
use hyperlane_core::{ChainResult, HyperlaneMessage};
use crate::relay_api::MailboxIndexer;

pub struct CosmosMailboxIndexer {
    // Chain-specific client
    domain: u32,
}

#[async_trait::async_trait]
impl MailboxIndexer for CosmosMailboxIndexer {
    async fn fetch_logs_by_tx_hash(&self, tx_hash: &str) -> ChainResult<Vec<HyperlaneMessage>> {
        // 1. Parse Cosmos tx_hash format
        // 2. Query tx from Cosmos node
        // 3. Extract Hyperlane events
        // 4. Parse into HyperlaneMessage
        todo!("Implement Cosmos message extraction")
    }

    fn domain(&self) -> u32 {
        self.domain
    }
}
```

3. Register in RegistryBuilder (see `registry_builder.rs`)

## Testing

### Testing the API Infrastructure (Without Provider Registry)

To test that the API endpoints work correctly before wiring up the ProviderRegistry:

```bash
# Enable API and disable normal indexing
export HYPERLANE_RELAYER_RELAY_API_ENABLED=true
export HYPERLANE_RELAYER_DISABLE_INDEXING=true

# Start relayer
cargo run --bin relayer -- --config-path ./config

# Test job creation (will fail at extraction, but proves endpoint works)
curl -X POST http://localhost:3000/relay \
  -H "Content-Type: application/json" \
  -d '{"origin_chain":"ethereum","tx_hash":"0x..."}' \
  | jq

# Test job status query
curl http://localhost:3000/relay/<job_id> | jq
```

**Expected behavior:**
- POST /relay returns job_id immediately (< 1s)
- GET /relay/:id shows job with status "Failed" and error "Provider registry or relay worker not configured"
- Normal contract indexing is disabled (no ContractSync, DbLoader tasks running)

### Without Provider Registry (API Enabled, Indexing Running)

```bash
# Enable API but keep normal indexing
export HYPERLANE_RELAYER_RELAY_API_ENABLED=true

# Start relayer
cargo run --bin relayer -- --config-path ./config

# Try to create relay job (will fail with "Provider registry not configured")
curl -X POST http://localhost:3000/relay \
  -H "Content-Type: application/json" \
  -d '{"origin_chain":"ethereum","tx_hash":"0x..."}'
```

### With Provider Registry (Works)

Once you've wired up the ProviderRegistry with EVM indexers:

```bash
# Send a warp transfer
TX_HASH=$(cast send $WARP_TOKEN "transferRemote(...)" ...)

# Create relay job
curl -X POST http://localhost:3000/relay \
  -H "Content-Type: application/json" \
  -d "{\"origin_chain\":\"ethereum\",\"tx_hash\":\"$TX_HASH\"}" \
  | jq

# Poll for status
JOB_ID="..." # from above response
curl http://localhost:3000/relay/$JOB_ID | jq .status
```

## Why is This Not Wired Up Yet?

The challenge is accessing the existing `EthereumMailboxIndexer` instances that were created during origin setup:

1. **Type Erasure**: `origin.message_sync` is a trait object (`Arc<dyn ContractSyncer<HyperlaneMessage>>`)
2. **No Direct Access**: There's no public API to extract the underlying `EthereumMailboxIndexer`
3. **Multiple Approaches**:
   - **Option A**: Downcast the trait object (fragile, type-specific)
   - **Option B**: Create new indexer instances (requires provider access)
   - **Option C**: Modify Origin struct to expose indexers (cleaner but requires refactoring)

**Recommendation**: Option B or C depending on your deployment architecture.

## Example: Complete EVM Wiring

Here's a complete example showing how to create new indexers:

```rust
// In build_router() or similar initialization code
let provider_registry = if relay_api_enabled {
    use crate::relay_api::{EvmMailboxIndexer, RegistryBuilder};
    use hyperlane_ethereum::EthereumMailboxIndexer;
    use ethers::providers::Middleware;

    let mut builder = RegistryBuilder::new();

    for (domain, origin) in &self.origins {
        if domain.domain_protocol() == HyperlaneDomainProtocol::Ethereum {
            // Get provider for this chain (from your chain conf)
            let provider = /* extract provider from origin.chain_conf */;

            // Get mailbox contract address
            let mailbox_address = /* extract from origin configuration */;

            // Create mailbox indexer
            let locator = ContractLocator {
                domain: domain.clone(),
                address: mailbox_address,
            };

            let eth_indexer = Arc::new(EthereumMailboxIndexer::new(
                provider.clone(),
                &locator,
                origin.chain_conf.reorg_period(),
            ));

            // Wrap in relay API adapter
            let relay_indexer = Arc::new(EvmMailboxIndexer::new(
                eth_indexer,
                domain.id(),
            ));

            // Register
            builder = builder.add_chain(
                domain,
                domain.name().to_string(),
                relay_indexer,
            );
        }
    }

    Some(builder.build())
} else {
    None
};
```

## Next Steps

1. **Choose your approach** for accessing/creating mailbox indexers
2. **Implement the wiring** in `relayer.rs`
3. **Test with local anvil chains** using the measurement script
4. **Add support for other protocols** as needed (Cosmos, Sealevel, etc.)

## Full API Documentation

See [RELAY_API.md](./RELAY_API.md) for complete API reference, usage examples, and error handling.

## Questions?

The relay API is **production-ready architecture** - it just needs the final wiring step to connect chain indexers to the ProviderRegistry. The pattern is clear, the challenge is accessing the right provider instances for your specific deployment configuration.

use std::sync::Arc;
use tracing::{info, warn};

use hyperlane_base::CoreMetrics;
use hyperlane_core::{HyperlaneDomain, HyperlaneDomainProtocol};

use super::{EvmMailboxIndexer, MailboxIndexer, ProviderRegistry};

/// Builds a ProviderRegistry by creating appropriate indexers for each configured chain
pub struct RegistryBuilder {
    registry: ProviderRegistry,
}

impl RegistryBuilder {
    pub fn new() -> Self {
        Self {
            registry: ProviderRegistry::new(),
        }
    }

    /// Add an indexer for a specific chain
    /// This method auto-detects the protocol type and creates the appropriate indexer
    pub fn add_chain(
        mut self,
        domain: &HyperlaneDomain,
        chain_name: String,
        indexer: Arc<dyn MailboxIndexer>,
    ) -> Self {
        info!(
            chain = %chain_name,
            domain_id = domain.id(),
            protocol = ?domain.domain_protocol(),
            "Registering chain for relay API"
        );

        self.registry = self.registry.with_indexer(chain_name, indexer);
        self
    }

    /// Build and return the ProviderRegistry
    pub fn build(self) -> ProviderRegistry {
        self.registry
    }
}

impl Default for RegistryBuilder {
    fn default() -> Self {
        Self::new()
    }
}

/// Helper to log unsupported protocol types
pub fn log_unsupported_protocol(chain_name: &str, protocol: HyperlaneDomainProtocol) {
    warn!(
        chain = %chain_name,
        protocol = ?protocol,
        "Chain protocol not yet supported for relay API. \
         Fast relay will not be available for this chain. \
         Supported protocols: EVM (Cosmos/CosmosNative coming soon)"
    );
}

/// Check if a protocol is supported for relay API
pub fn is_protocol_supported(protocol: HyperlaneDomainProtocol) -> bool {
    // TODO: Add Cosmos and CosmosNative support
    // Blocked on: proper provider/indexer initialization from chain config
    matches!(protocol, HyperlaneDomainProtocol::Ethereum)
}

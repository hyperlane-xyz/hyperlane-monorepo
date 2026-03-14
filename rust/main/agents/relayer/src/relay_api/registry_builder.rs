use std::sync::Arc;
use tracing::info;

use hyperlane_core::{HyperlaneDomain, HyperlaneMessage, Indexer};

use super::ProviderRegistry;

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
    pub fn add_chain(
        mut self,
        domain: &HyperlaneDomain,
        chain_name: String,
        indexer: Arc<dyn Indexer<HyperlaneMessage>>,
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

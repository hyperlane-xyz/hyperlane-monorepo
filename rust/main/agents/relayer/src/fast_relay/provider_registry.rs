use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use hyperlane_core::{ChainResult, H512};

use crate::fast_relay::ExtractedMessage;

/// Function type for extracting messages from a transaction
pub type ExtractorFn = Arc<
    dyn Fn(H512) -> Pin<Box<dyn Future<Output = ChainResult<Option<ExtractedMessage>>> + Send>>
        + Send
        + Sync,
>;

/// Registry of message extractors for fast relay
///
/// This registry stores functions that can extract Hyperlane messages
/// from transactions for each origin chain. This avoids trait object
/// issues with ethers Middleware.
#[derive(Clone)]
pub struct ProviderRegistry {
    /// Map of chain name to extractor function
    extractors: HashMap<String, ExtractorFn>,
}

impl ProviderRegistry {
    /// Create a new empty registry
    pub fn new() -> Self {
        Self {
            extractors: HashMap::new(),
        }
    }

    /// Register an extractor function for a chain
    pub fn register<F>(&mut self, chain_name: String, extractor: F)
    where
        F: Fn(H512) -> Pin<Box<dyn Future<Output = ChainResult<Option<ExtractedMessage>>> + Send>>
            + Send
            + Sync
            + 'static,
    {
        self.extractors
            .insert(chain_name, Arc::new(extractor));
    }

    /// Extract message from a transaction on the given chain
    pub async fn extract(
        &self,
        chain_name: &str,
        tx_hash: H512,
    ) -> Option<ChainResult<Option<ExtractedMessage>>> {
        let extractor = self.extractors.get(chain_name)?;
        Some(extractor(tx_hash).await)
    }

    /// Check if a chain is registered
    pub fn has_chain(&self, chain_name: &str) -> bool {
        self.extractors.contains_key(chain_name)
    }

    /// Get list of registered chains
    pub fn chains(&self) -> Vec<String> {
        self.extractors.keys().cloned().collect()
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for ProviderRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderRegistry")
            .field("chains", &self.chains())
            .finish()
    }
}

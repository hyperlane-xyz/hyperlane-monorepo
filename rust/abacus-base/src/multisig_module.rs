use std::fmt::Debug;
use std::sync::Arc;

use abacus_core::accumulator::merkle::Proof;
use async_trait::async_trait;
use ethers::core::types::H256;
use ethers::types::{U256, H160};
use eyre::Result;

use abacus_core::{
    AbacusContract, ChainCommunicationError, MultisigModule,
    MultisigSignedCheckpoint,
};

/// Caching MultisigModule type
#[derive(Debug, Clone)]
pub struct CachingMultisigModule {
    multisig_module: Arc<dyn MultisigModule>,
}

impl std::fmt::Display for CachingMultisigModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl CachingMultisigModule {
    /// Instantiate new CachingMultisigModule
    pub fn new(multisig_module: Arc<dyn MultisigModule>) -> Self {
        Self {
            multisig_module,
        }
    }

    /// Return handle on multisig_module object
    pub fn multisig_module(&self) -> &Arc<dyn MultisigModule> {
        &self.multisig_module
    }
}

#[async_trait]
impl MultisigModule for CachingMultisigModule {
    async fn threshold(&self, domain: u32) -> Result<U256, ChainCommunicationError> {
        self.multisig_module.threshold(domain).await
    }

    async fn validators(&self, domain: u32) -> Result<Vec<H160>, ChainCommunicationError> {
        self.multisig_module.validators(domain).await
    }

    async fn format_metadata(&self, checkpoint: &MultisigSignedCheckpoint, proof: Proof) -> Result<Vec<u8>, ChainCommunicationError> {
        self.multisig_module.format_metadata(checkpoint, proof).await

    }
}

impl AbacusContract for CachingMultisigModule {
    fn chain_name(&self) -> &str {
        self.multisig_module.chain_name()
    }

    fn address(&self) -> H256 {
        self.multisig_module.address()
    }
}

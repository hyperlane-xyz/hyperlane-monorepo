use std::fmt::Debug;
use std::sync::Arc;

use abacus_core::accumulator::merkle::Proof;
use async_trait::async_trait;
use ethers::core::types::H256;
use ethers::types::{H160, U256};
use eyre::Result;

use abacus_core::{
    AbacusContract, ChainCommunicationError, MultisigIsm, MultisigSignedCheckpoint, AbacusChain,
};

/// Caching MultisigIsm type
#[derive(Debug, Clone)]
pub struct CachingMultisigIsm {
    multisig_ism: Arc<dyn MultisigIsm>,
}

impl std::fmt::Display for CachingMultisigIsm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl CachingMultisigIsm {
    /// Instantiate new CachingMultisigIsm
    pub fn new(multisig_ism: Arc<dyn MultisigIsm>) -> Self {
        Self { multisig_ism }
    }

    /// Return handle on multisig_ism object
    pub fn multisig_ism(&self) -> &Arc<dyn MultisigIsm> {
        &self.multisig_ism
    }
}

#[async_trait]
impl MultisigIsm for CachingMultisigIsm {
    async fn format_metadata(
        &self,
        checkpoint: &MultisigSignedCheckpoint,
        proof: Proof,
    ) -> Result<Vec<u8>, ChainCommunicationError> {
        self.multisig_ism
            .format_metadata(checkpoint, proof)
            .await
    }

    async fn threshold(&self, domain: u32) -> Result<U256, ChainCommunicationError> {
        self.multisig_ism.threshold(domain).await
    }

    async fn validators(&self, domain: u32) -> Result<Vec<H160>, ChainCommunicationError> {
        self.multisig_ism.validators(domain).await
    }
}

impl AbacusChain for CachingMultisigIsm {
    fn chain_name(&self) -> &str {
        self.multisig_ism.chain_name()
    }

    fn local_domain(&self) -> u32 {
        self.multisig_ism.local_domain()
    }
}

impl AbacusContract for CachingMultisigIsm {

    fn address(&self) -> H256 {
        self.multisig_ism.address()
    }
}

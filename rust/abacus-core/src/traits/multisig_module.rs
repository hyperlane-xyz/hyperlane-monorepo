use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;
use ethers::types::{H160, U256};
use eyre::Result;

use crate::{
    traits::{ChainCommunicationError},
    AbacusContract, MultisigSignedCheckpoint, accumulator::merkle::Proof,
};

/// Interface for the MultisigModule chain contract. Allows abstraction over different
/// chains
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait MultisigModule: AbacusContract + Send + Sync + Debug {
    /// Returns the metadata needed by the contract's verify function
    async fn format_metadata(&self, checkpoint: &MultisigSignedCheckpoint, proof: Proof) -> Result<Vec<u8>, ChainCommunicationError>;

    /// Fetch the threshold for the provided domain
    async fn threshold(&self, domain: u32) -> Result<U256, ChainCommunicationError>;

    /// Fetch the validators for the provided domain
    async fn validators(&self, domain: u32) -> Result<Vec<H160>, ChainCommunicationError>;
}

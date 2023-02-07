use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;
use thiserror::Error;

use crate::{BlockInfo, ChainResult, HyperlaneChain, TxnInfo, H256};

/// Interface for a provider. Allows abstraction over different provider types
/// for different chains.
///
/// This does not seek to fully abstract all functions we use of the providers
/// as the wrappers provided by ethers for given contracts are quite nice,
/// however, there are some generic calls that we should be able to make outside
/// the context of a contract.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait HyperlaneProvider: HyperlaneChain + Send + Sync + Debug {
    /// Get block info for a given block hash
    async fn get_block_by_hash(&self, hash: &H256) -> ChainResult<BlockInfo>;

    /// Get txn info for a given txn hash
    async fn get_txn_by_hash(&self, hash: &H256) -> ChainResult<TxnInfo>;

    /// Returns whether a contract exists at the provided address
    async fn is_contract(&self, address: &H256) -> ChainResult<bool>;
}

/// Errors when querying for provider information.
#[derive(Error, Debug)]
pub enum HyperlaneProviderError {
    /// The requested block hash is not yet known by the provider
    #[error("Block is not part of chain yet {0:?}")]
    BlockIsNotPartOfChainYet(H256),
    /// The provider did not return the gas which was used
    #[error("Provider did not return gas used")]
    NoGasUsed,
    /// Could not find a transaction, block, or other object
    #[error("Could not find object from provider with hash {0:?}")]
    CouldNotFindObjectByHash(H256),
}

use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;
use std::any::Any;
use thiserror::Error;

use downcast_rs::{impl_downcast, DowncastSync};

use crate::{BlockInfo, ChainInfo, ChainResult, HyperlaneChain, TxnInfo, H256, H512, U256};

/// Interface for a provider. Allows abstraction over different provider types
/// for different chains.
///
/// This does not seek to fully abstract all functions we use of the providers
/// as the wrappers provided by ethers for given contracts are quite nice,
/// however, there are some generic calls that we should be able to make outside
/// the context of a contract.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait HyperlaneProvider: HyperlaneChain + Send + Sync + Debug + DowncastSync {
    /// Get block info for a given block height
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo>;

    /// Get txn info for a given txn hash
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo>;

    /// Returns whether a contract exists at the provided address
    async fn is_contract(&self, address: &H256) -> ChainResult<bool>;

    /// Fetch the balance of the wallet address associated with the chain provider.
    async fn get_balance(&self, address: String) -> ChainResult<U256>;

    /// Fetch metrics related to this chain
    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>>;
}

impl_downcast!(sync HyperlaneProvider);

/// Errors when querying for provider information.
#[derive(Error, Debug)]
pub enum HyperlaneProviderError {
    /// The provider did not return the gas which was used
    #[error("Provider did not return gas used")]
    NoGasUsed,
    /// Could not find a transaction by hash
    #[error("Could not find transaction from provider with hash {0:?}")]
    CouldNotFindTransactionByHash(H512),
    /// Could not find a block by height
    #[error("Could not find block from provider with height {0:?}")]
    CouldNotFindBlockByHeight(u64),
    /// The requested block does not have its hash
    #[error("Block with height {0:?} does not contain its hash")]
    BlockWithoutHash(u64),
    /// Incorrect block is received
    #[error("Requested block with height {0:?}, received block with height {1:?}")]
    IncorrectBlockByHeight(u64, u64),
}

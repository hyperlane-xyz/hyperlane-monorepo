use async_trait::async_trait;
use ethers::prelude::H256;
use eyre::Result;
use std::fmt::Debug;

use crate::{AbacusChain, BlockInfo, TxnInfo};

/// Interface for a provider. Allows abstraction over different provider types
/// for different chains.
///
/// This does not seek to fully abstract all functions we use of the providers
/// as the wrappers provided by ethers for given contracts are quite nice,
/// however, there are some generic calls that we should be able to make outside
/// the context of a contract.
#[async_trait]
pub trait AbacusProvider: AbacusChain + Send + Sync + Debug {
    /// Get block info for a given block hash
    async fn get_block_by_hash(&self, hash: &H256) -> Result<BlockInfo>;

    /// Get txn info for a given txn hash
    async fn get_txn_by_hash(&self, hash: &H256) -> Result<TxnInfo>;
}

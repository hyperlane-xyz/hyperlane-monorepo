use std::fmt::Debug;
use async_trait::async_trait;
use ethers::prelude::{H256, U256};
use eyre::Result;

use crate::AbacusChain;

struct BlockInfo {
    timestamp: u64,

    gas_price: U256,
}

pub struct TxnInfo {
    /// Amount of gas which was used by this transaction
    gas_used: U256,
    /// Address of the person who sent this transaction
    sender: H256,
}

/// Interface for a provider. Allows abstraction over different provider types
/// for different chains.
///
/// This does not seek to fully abstract all functions we use of the providers
/// as the wrappers provided by ethers for given contracts are quite nice,
/// however, there are some generic calls that we should be able to make outside
/// the context of a contract.
#[async_trait]
pub trait Provider: AbacusChain + Send + Sync + Debug {
    async fn get_transaction_by_hash(hash: &H256) -> Result<TxnInfo>;

    async fn get_block_by_hash(block: &H256) -> Result<BlockInfo>;
}

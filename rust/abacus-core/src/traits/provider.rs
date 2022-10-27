use std::fmt::Debug;
use async_trait::async_trait;
use ethers::prelude::{H256, U256};
use eyre::Result;

use crate::AbacusChain;

pub struct BlockInfo {
    /// Hash of this block
    pub hash: H256,
    /// Unix timestamp of this block's creation in seconds
    pub timestamp: u64,
    /// Block height or the nth block in the chain
    pub number: u64,
    /// Total used gas by transactions in this block
    pub gas_used: U256,
    /// Maximum amount of gas allowed in this block
    pub gas_limit: U256,
}

pub struct TxnInfo {
    /// Hash of this transaction
    pub hash: H256,
    /// Amount of gas which was used by this transaction
    pub gas_used: U256,
    /// Price paid for gas on this txn.
    pub gas_price: U256,
    /// Nonce of this transaction by the sender.
    pub nonce: u64,
    /// Address of the person who sent this transaction
    pub sender: H256,
    /// Address of the receiver or contract that was interacted with
    pub recipient: H256,
}

/// Interface for a provider. Allows abstraction over different provider types
/// for different chains.
///
/// This does not seek to fully abstract all functions we use of the providers
/// as the wrappers provided by ethers for given contracts are quite nice,
/// however, there are some generic calls that we should be able to make outside
/// the context of a contract.
#[async_trait]
pub trait AbacusProvider: AbacusChain + Send + Sync + Debug {
    async fn get_block_by_hash(&self, hash: &H256) -> Result<BlockInfo>;
    async fn get_txn_by_hash(&self, hash: &H256) -> Result<TxnInfo>;
}

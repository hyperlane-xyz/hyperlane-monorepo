use ethers::prelude::{H256, U256};

/// Info about a given block in the chain.
#[derive(Debug)]
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

/// Information about a given transaction in the chain.
#[derive(Debug)]
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

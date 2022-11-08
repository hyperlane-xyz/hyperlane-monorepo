use ethers::prelude::{H256, U256};

/// Info about a given block in the chain.
#[derive(Debug, Clone)]
pub struct BlockInfo {
    /// Hash of this block
    pub hash: H256,
    /// Unix timestamp of this block's creation in seconds
    pub timestamp: u64,
    /// Block height or the nth block in the chain
    pub number: u64,
}

/// Information about a given transaction in the chain.
#[derive(Debug, Clone)]
pub struct TxnInfo {
    /// Hash of this transaction
    pub hash: H256,
    /// Amount of gas which was allocated for running the transaction
    pub gas_limit: U256,
    /// Represents the maximum tx fee that will go to the miner as part of the
    /// user's fee payment.
    pub max_priority_fee_per_gas: Option<U256>,
    /// Represents the maximum amount that a user is willing to pay for their tx
    /// (inclusive of baseFeePerGas and maxPriorityFeePerGas). The difference
    /// between maxFeePerGas and baseFeePerGas + maxPriorityFeePerGas is
    /// “refunded” to the user.
    pub max_fee_per_gas: Option<U256>,
    /// Price paid for gas on this txn. None for type 2 txns.
    pub gas_price: Option<U256>,
    /// Nonce of this transaction by the sender.
    pub nonce: u64,
    /// Address of the person who sent this transaction
    pub sender: H256,
    /// Address of the receiver or contract that was interacted with
    pub recipient: Option<H256>,
    /// If the txn has been processed, we can also report some additional information.
    pub receipt: Option<TxnReceiptInfo>,
}

/// Information about the execution of a transaction.
#[derive(Debug, Clone)]
pub struct TxnReceiptInfo {
    /// Amount of gas which was used by this transaction
    pub gas_used: U256,
    /// Cumulative gas used within the block after this was executed.
    pub cumulative_gas_used: U256,
    /// The price paid post-execution by the transaction (i.e. base fee +
    /// priority fee). Both fields in 1559-style transactions are maximums (max
    /// fee + max priority fee), the amount that's actually paid by users can
    /// only be determined post-execution
    pub effective_gas_price: Option<U256>,
}

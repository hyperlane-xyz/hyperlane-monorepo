use ethers::types::U256;

/// A payment of Outbox native tokens for a message
pub struct InterchainGasPayment {
    /// The index of the message's leaf in the merkle tree
    pub leaf_index: u32,
    /// The payment amount, in Outbox native token wei
    pub amount: U256,
}

use async_trait::async_trait;
use ethers::types::U256;

/// A payment of Outbox native tokens for a message
pub struct InterchainGasPayment {
    /// The index of the message's leaf in the merkle tree
    pub leaf_index: u32,
    /// The payment amount, in Outbox native token wei
    pub amount: U256,
}

/// Interface for the InterchainGasPaymaster chain contract.
/// Allows abstraction over different chains.
#[async_trait]
pub trait InterchainGasPaymaster: Send + Sync + std::fmt::Debug {}

/// Interface for retrieving event data emitted specifically by the InterchainGasPaymaster
#[async_trait]
pub trait InterchainGasPaymasterEvents:
    InterchainGasPaymaster + Send + Sync + std::fmt::Debug
{
}

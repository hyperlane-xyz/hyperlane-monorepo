use async_trait::async_trait;

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

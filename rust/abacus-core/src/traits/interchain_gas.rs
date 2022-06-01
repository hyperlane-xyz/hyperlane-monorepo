use std::fmt::Debug;

use async_trait::async_trait;

use crate::AbacusContract;

/// Interface for the InterchainGasPaymaster chain contract.
/// Allows abstraction over different chains.
#[async_trait]
pub trait InterchainGasPaymaster: AbacusContract + Send + Sync + Debug {}

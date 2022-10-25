use std::fmt::Debug;

use crate::AbacusChain;

/// Interface for a provider. Allows abstraction over different provider types
/// for different chains.
///
/// This does not seek to fully abstract all functions we use of the providers
/// as the wrappers provided by ethers for given contracts are quite nice,
/// however, there are some generic calls that we should be able to make outside
/// the context of a contract.
pub trait Provider: AbacusChain + Send + Sync + Debug {}

use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{
    ChainResult, HyperlaneContract,
};

/// Interface for the Ism chain contract. Allows abstraction over
/// different chains
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait Ism: HyperlaneContract + Send + Sync + Debug {
    /// Returns the validator and threshold needed to verify message
    async fn module_type(
        &self
    ) -> ChainResult<u8>;
}

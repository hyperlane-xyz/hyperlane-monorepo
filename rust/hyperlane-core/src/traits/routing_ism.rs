use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{ChainResult, HyperlaneContract, HyperlaneMessage, H256};

/// Interface for the RoutingIsm chain contract. Allows abstraction over
/// different chains
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait RoutingIsm: HyperlaneContract + Send + Sync + Debug {
    /// Returns the validator and threshold needed to verify message
    async fn route(&self, message: &HyperlaneMessage) -> ChainResult<H256>;
}

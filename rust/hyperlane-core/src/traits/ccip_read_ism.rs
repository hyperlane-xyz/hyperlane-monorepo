use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{ChainResult, HyperlaneContract, HyperlaneMessage};

/// Interface for the CcipReadIsm chain contract. Allows abstraction over
/// different chains
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait CcipReadIsm: HyperlaneContract + Send + Sync + Debug {
    /// Returns the validator and threshold needed to verify message
    async fn get_offchain_verify_info(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<bool>;
}

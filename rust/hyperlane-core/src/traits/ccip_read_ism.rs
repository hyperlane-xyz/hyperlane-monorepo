use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{ChainResult, HyperlaneContract};

/// Interface for the CcipReadIsm chain contract
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait CcipReadIsm: HyperlaneContract + Send + Sync + Debug {
    /// Reverts with a custom error specifying how to query for offchain information
    async fn get_offchain_verify_info(&self, message: Vec<u8>) -> ChainResult<()>;
}

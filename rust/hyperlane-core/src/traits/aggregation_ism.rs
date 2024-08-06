use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{ChainResult, HyperlaneContract, HyperlaneMessage, H256};

/// Interface for the AggregationIsm chain contract. Allows abstraction over
/// different chains
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait AggregationIsm: HyperlaneContract + Send + Sync + Debug {
    /// Returns the `m` ISMs and `n` threshold needed to n-of-m verify the message
    async fn modules_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)>;
}

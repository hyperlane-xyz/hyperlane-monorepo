use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{ChainResult, HyperlaneContract};

/// Interface for the CctpIsm chain contract
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait CctpIsm: HyperlaneContract + Send + Sync + Debug {
    /// TODO : fix function name
    async fn get_offchain_verify_info(&self, message: Vec<u8>) -> ChainResult<bool>;
}

use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{
    ChainResult, HyperlaneContract, 
    H256,
};

/// Interface for the ValidatorAnnounce chain contract. Allows abstraction over
/// different chains
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait ValidatorAnnounce: HyperlaneContract + Send + Sync + Debug {
    async fn get_announced_storage_locations(
        &self,
        validators: Vec<H256>,
    ) -> ChainResult<Vec<Vec<String>>>;
}

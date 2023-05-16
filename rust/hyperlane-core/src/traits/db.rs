use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;
use eyre::Result;

use crate::{HyperlaneMessage, LogMeta};

/// Interface for a HyperlaneDB that ingests logs.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait HyperlaneDB<T>: Send + Sync + Debug + 'static {
    /// Store a list of logs and their associated metadata
    /// Returns the number of elements that were stored.
    async fn store_logs(&self, logs: &[(T, LogMeta)]) -> Result<u32>;
}

/// Extension of HyperlaneDB trait that supports getting the block number at which a known message was dispatched.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait HyperlaneMessageDB:
    HyperlaneDB<HyperlaneMessage> + Sync + Send + Debug + 'static
{
    /// Gets the block number at which a known message was dispatched.
    async fn retrieve_dispatched_block_number(&self, nonce: u32) -> Result<Option<u64>>;
}

use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;
use eyre::Result;

use crate::{HyperlaneMessage, LogMeta};

/// Interface for a HyperlaneLogStore that ingests logs.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait HyperlaneLogStore<T>: Send + Sync + Debug {
    /// Store a list of logs and their associated metadata
    /// Returns the number of elements that were stored.
    async fn store_logs(&self, logs: &[(T, LogMeta)]) -> Result<u32>;
}

/// Extension of HyperlaneLogStore trait that supports getting the block number at which a known message was dispatched.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait HyperlaneMessageStore: HyperlaneLogStore<HyperlaneMessage> {
    /// Gets a message by nonce.
    async fn retrieve_message_by_nonce(&self, nonce: u32) -> Result<Option<HyperlaneMessage>>;
    /// Gets the block number at which a message was dispatched.
    async fn retrieve_dispatched_block_number(&self, nonce: u32) -> Result<Option<u64>>;
}

/// Extension of HyperlaneLogStore trait that supports a high watermark for the highest indexed block number.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait HyperlaneWatermarkedLogStore<T>: HyperlaneLogStore<T> {
    /// Gets the block number high watermark
    async fn retrieve_high_watermark(&self) -> Result<Option<u32>>;
    /// Stores the block number high watermark
    async fn store_high_watermark(&self, block_number: u32) -> Result<()>;
}

use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;
use eyre::{Result};

use crate::{HyperlaneMessage, InterchainGasPayment, LogMeta, H256};

/// Interface for a HyperlaneDb. 
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait HyperlaneDB: Send + Sync + Debug {
    /// Store a list of dispatched messages and their associated metadata.
    fn store_dispatched_messages(
        &self,
        messages: &[(HyperlaneMessage, LogMeta)],
    ) -> Result<u32>;

    /// Store a list of delivered messages and their associated metadata.
    fn store_delivered_messages(
        &self,
        deliveries: &[(H256, LogMeta)],
    ) -> Result<u32>;

    /// Store a list of interchain gas payments and their associated metadata.
    fn store_gas_payments(
        &self,
        payments: &[(InterchainGasPayment, LogMeta)],
    ) -> Result<u32>;

    /// Retrieves the block number at which the message with the provided nonce
    /// was dispatched.
    fn retrieve_dispatched_block_number(&self, nonce: u32) -> Result<Option<u64>>;
}

use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{HyperlaneMessage, InterchainGasPayment, LogMeta, H256};

/// Interface for a HyperlaneDb. 
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait HyperlaneDB<E>: Send + Sync + Debug {
    /// Store a list of dispatched messages and their associated metadata.
    fn store_dispatched_messages(
        &self,
        messages: &[(HyperlaneMessage, LogMeta)],
    ) -> Result<u32, E>;

    /// Store a list of delivered messages and their associated metadata.
    fn store_delivered_messages(
        &self,
        deliveries: &[(H256, LogMeta)],
    ) -> Result<u32, E>;

    /// Store a list of interchain gas payments and their associated metadata.
    fn store_gas_payment(
        &self,
        payments: &[(InterchainGasPayment, LogMeta)],
    ) -> Result<bool, E>;
}

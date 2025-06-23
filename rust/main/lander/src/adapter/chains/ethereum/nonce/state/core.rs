use std::sync::Arc;

use ethers::prelude::Address;

use hyperlane_core::HyperlaneDomain;

use crate::adapter::chains::ethereum::EthereumAdapterMetrics;
use crate::dispatcher::TransactionDb;

use super::super::db::NonceDb;

pub(crate) struct NonceManagerState {
    pub(super) nonce_db: Arc<dyn NonceDb>,
    pub(super) tx_db: Arc<dyn TransactionDb>,
    pub(super) address: Address,
    pub(super) metrics: EthereumAdapterMetrics,
}

impl NonceManagerState {
    pub(crate) fn new(
        nonce_db: Arc<dyn NonceDb>,
        tx_db: Arc<dyn TransactionDb>,
        address: Address,
        metrics: EthereumAdapterMetrics,
    ) -> Self {
        Self {
            nonce_db,
            tx_db,
            address,
            metrics,
        }
    }
}

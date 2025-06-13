use std::sync::Arc;

use super::super::db::NonceDb;
use crate::adapter::chains::ethereum::EthereumAdapterMetrics;
use crate::dispatcher::TransactionDb;
use ethers::prelude::Address;
use hyperlane_core::HyperlaneDomain;

pub(crate) struct NonceManagerState {
    pub(super) domain: HyperlaneDomain,
    pub(super) nonce_db: Arc<dyn NonceDb>,
    pub(super) tx_db: Arc<dyn TransactionDb>,
    pub(super) address: Address,
    pub(super) metrics: EthereumAdapterMetrics,
}

impl NonceManagerState {
    pub(crate) fn new(
        domain: HyperlaneDomain,
        nonce_db: Arc<dyn NonceDb>,
        tx_db: Arc<dyn TransactionDb>,
        address: Address,
        metrics: EthereumAdapterMetrics,
    ) -> Self {
        Self {
            domain,
            nonce_db,
            tx_db,
            address,
            metrics,
        }
    }
}

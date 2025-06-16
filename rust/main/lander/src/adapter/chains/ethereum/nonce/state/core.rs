use std::sync::Arc;

use ethers::prelude::Address;

use crate::dispatcher::TransactionDb;

use super::super::db::NonceDb;

pub struct NonceManagerState {
    pub(super) nonce_db: Arc<dyn NonceDb>,
    pub(super) tx_db: Arc<dyn TransactionDb>,
    pub(super) address: Address,
}

impl NonceManagerState {
    pub fn new(
        nonce_db: Arc<dyn NonceDb>,
        tx_db: Arc<dyn TransactionDb>,
        address: Address,
    ) -> Self {
        Self {
            nonce_db,
            tx_db,
            address,
        }
    }
}

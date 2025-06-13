use std::sync::Arc;

use ethers_core::types::Address;

use hyperlane_core::U256;

use crate::dispatcher::TransactionDb;

use super::db::NonceDb;

pub(crate) use validate::NonceAction;

mod assign;
mod boundary;
mod db;
mod validate;

pub struct NonceManagerState {
    nonce_db: Arc<dyn NonceDb>,
    tx_db: Arc<dyn TransactionDb>,
    address: Address,
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

#[cfg(test)]
mod tests;

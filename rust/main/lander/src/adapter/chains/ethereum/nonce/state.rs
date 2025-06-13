use std::sync::Arc;

use ethers_core::types::Address;
use tracing::{error, info, warn};

use hyperlane_core::U256;

use crate::adapter::chains::ethereum::transaction::Precursor;
use crate::dispatcher::TransactionDb;
use crate::transaction::{Transaction, TransactionUuid};

use super::db::NonceDb;
use super::error::{NonceError, NonceResult};
use super::status::NonceStatus;

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

#![allow(unused)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use ethers_core::abi::Function;
use ethers_core::types::Address;
use hyperlane_base::db::DbResult;
use hyperlane_core::U256;

use crate::adapter::EthereumTxPrecursor;
use crate::transaction::{Transaction, TransactionStatus, TransactionUuid, VmSpecificTxData};

use super::db::NonceDb;
use super::state::NonceManagerState;
use super::status::NonceStatus;

// Common mock NonceDb for tests
pub struct MockNonceDb {
    pub finalized: Mutex<HashMap<Address, U256>>,
    pub upper: Mutex<HashMap<Address, U256>>,
    pub status: Mutex<HashMap<(U256, Address), NonceStatus>>,
}

impl MockNonceDb {
    pub fn new() -> Self {
        Self {
            finalized: Mutex::new(HashMap::new()),
            upper: Mutex::new(HashMap::new()),
            status: Mutex::new(HashMap::new()),
        }
    }
}

#[async_trait]
impl NonceDb for MockNonceDb {
    async fn retrieve_finalized_nonce_by_signer_address(
        &self,
        signer_address: &Address,
    ) -> DbResult<Option<U256>> {
        Ok(self.finalized.lock().unwrap().get(signer_address).cloned())
    }

    async fn store_finalized_nonce_by_signer_address(
        &self,
        signer_address: &Address,
        nonce: &U256,
    ) -> DbResult<()> {
        self.finalized
            .lock()
            .unwrap()
            .insert(*signer_address, *nonce);
        Ok(())
    }

    async fn retrieve_upper_nonce_by_signer_address(
        &self,
        signer_address: &Address,
    ) -> DbResult<Option<U256>> {
        Ok(self.upper.lock().unwrap().get(signer_address).cloned())
    }

    async fn store_upper_nonce_by_signer_address(
        &self,
        signer_address: &Address,
        nonce: &U256,
    ) -> DbResult<()> {
        self.upper.lock().unwrap().insert(*signer_address, *nonce);
        Ok(())
    }

    async fn retrieve_transaction_uuid_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &Address,
    ) -> DbResult<Option<TransactionUuid>> {
        todo!()
    }

    async fn store_transaction_uuid_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &Address,
        nonce_status: &TransactionUuid,
    ) -> DbResult<()> {
        todo!()
    }
}

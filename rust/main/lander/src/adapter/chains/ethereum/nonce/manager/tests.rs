use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use ethers_core::abi::Function;
use ethers_core::types::Address;

use hyperlane_base::db::DbResult;
use hyperlane_core::U256;

use crate::adapter::chains::ethereum::nonce::db::NonceDb;
use crate::adapter::EthereumTxPrecursor;
use crate::transaction::{Transaction, TransactionStatus, TransactionUuid, VmSpecificTxData};
use crate::TransactionDropReason;

use super::NonceManager;
use super::NonceManagerState;
use super::NonceStatus;

struct MockNonceDb {
    lowest: Mutex<HashMap<Address, U256>>,
    upper: Mutex<HashMap<Address, U256>>,
    status: Mutex<HashMap<(U256, Address), NonceStatus>>,
}

impl MockNonceDb {
    fn new() -> Self {
        Self {
            lowest: Mutex::new(HashMap::new()),
            upper: Mutex::new(HashMap::new()),
            status: Mutex::new(HashMap::new()),
        }
    }
}

#[async_trait]
impl NonceDb for MockNonceDb {
    async fn retrieve_lowest_available_nonce_by_signer_address(
        &self,
        signer_address: &Address,
    ) -> DbResult<Option<U256>> {
        Ok(self.lowest.lock().unwrap().get(signer_address).cloned())
    }

    async fn store_lowest_available_nonce_by_signer_address(
        &self,
        signer_address: &Address,
        nonce: &U256,
    ) -> DbResult<()> {
        self.lowest.lock().unwrap().insert(*signer_address, *nonce);
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

    async fn retrieve_nonce_status_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &Address,
    ) -> DbResult<Option<NonceStatus>> {
        Ok(self
            .status
            .lock()
            .unwrap()
            .get(&(*nonce, *signer_address))
            .cloned())
    }

    async fn store_nonce_status_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &Address,
        nonce_status: &NonceStatus,
    ) -> DbResult<()> {
        self.status
            .lock()
            .unwrap()
            .insert((*nonce, *signer_address), nonce_status.clone());
        Ok(())
    }
}

#[allow(deprecated)]
fn make_tx(
    uuid: TransactionUuid,
    status: TransactionStatus,
    nonce: U256,
    address: Address,
) -> Transaction {
    let mut precursor = EthereumTxPrecursor {
        tx: Default::default(),
        function: Function {
            name: "".to_string(),
            inputs: vec![],
            outputs: vec![],
            constant: None,
            state_mutability: Default::default(),
        },
    };

    precursor.tx.set_nonce(nonce);
    precursor.tx.set_from(address);

    let tx = Transaction {
        uuid,
        tx_hashes: vec![],
        vm_specific_data: VmSpecificTxData::Evm(precursor),
        payload_details: vec![],
        status,
        submission_attempts: 0,
        creation_timestamp: Default::default(),
        last_submission_attempt: None,
    };

    tx
}

#[tokio::test]
async fn test_update_nonce_status_inserts_when_not_tracked() {
    let db = Arc::new(MockNonceDb::new());
    let address = Address::random();
    let state = Arc::new(NonceManagerState::new(db.clone(), address));
    let manager = NonceManager {
        address,
        state: state.clone(),
        _nonce_updater: Default::default(),
    };

    let uuid = TransactionUuid::random();
    let nonce = U256::from(1);
    let tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        nonce,
        address,
    );

    // Not tracked: should insert
    manager.update_nonce_status(&tx, &tx.status).await.unwrap();
    let status = db
        .retrieve_nonce_status_by_nonce_and_signer_address(&nonce, &address)
        .await
        .unwrap();
    assert!(matches!(status, Some(NonceStatus::Taken(u)) if u == uuid));
}

#[tokio::test]
async fn test_update_nonce_status_noop_when_same_status() {
    let db = Arc::new(MockNonceDb::new());
    let address = Address::random();
    let state = Arc::new(NonceManagerState::new(db.clone(), address));
    let manager = NonceManager {
        address,
        state: state.clone(),
        _nonce_updater: Default::default(),
    };

    let uuid = TransactionUuid::random();
    let nonce = U256::from(2);
    db.store_nonce_status_by_nonce_and_signer_address(
        &nonce,
        &address,
        &NonceStatus::Taken(uuid.clone()),
    )
    .await
    .unwrap();

    let tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        nonce,
        address,
    );

    // Should be noop (no error, no change)
    manager.update_nonce_status(&tx, &tx.status).await.unwrap();
    let status = db
        .retrieve_nonce_status_by_nonce_and_signer_address(&nonce, &address)
        .await
        .unwrap();
    assert!(matches!(status, Some(NonceStatus::Taken(u)) if u == uuid));
}

#[tokio::test]
async fn test_update_nonce_status_freed_to_taken() {
    let db = Arc::new(MockNonceDb::new());
    let address = Address::random();
    let state = Arc::new(NonceManagerState::new(db.clone(), address));
    let manager = NonceManager {
        address,
        state: state.clone(),
        _nonce_updater: Default::default(),
    };

    let uuid = TransactionUuid::random();
    let nonce = U256::from(3);
    db.store_nonce_status_by_nonce_and_signer_address(
        &nonce,
        &address,
        &NonceStatus::Freed(uuid.clone()),
    )
    .await
    .unwrap();

    let tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        nonce,
        address,
    );

    // Freed -> Taken (should update)
    manager.update_nonce_status(&tx, &tx.status).await.unwrap();
    let status = db
        .retrieve_nonce_status_by_nonce_and_signer_address(&nonce, &address)
        .await
        .unwrap();
    assert!(matches!(status, Some(NonceStatus::Taken(u)) if u == uuid));
}

#[tokio::test]
async fn test_update_nonce_status_same_tx_uuid_updates_status() {
    let db = Arc::new(MockNonceDb::new());
    let address = Address::random();
    let state = Arc::new(NonceManagerState::new(db.clone(), address));
    let manager = NonceManager {
        address,
        state: state.clone(),
        _nonce_updater: Default::default(),
    };

    let uuid = TransactionUuid::random();
    let nonce = U256::from(4);
    db.store_nonce_status_by_nonce_and_signer_address(
        &nonce,
        &address,
        &NonceStatus::Taken(uuid.clone()),
    )
    .await
    .unwrap();

    let tx = make_tx(uuid.clone(), TransactionStatus::Finalized, nonce, address);

    // Taken -> Committed (same tx_uuid, should update)
    manager.update_nonce_status(&tx, &tx.status).await.unwrap();
    let status = db
        .retrieve_nonce_status_by_nonce_and_signer_address(&nonce, &address)
        .await
        .unwrap();
    assert!(matches!(status, Some(NonceStatus::Committed(u)) if u == uuid));
}

#[tokio::test]
async fn test_update_nonce_status_different_tx_uuid_errors() {
    let db = Arc::new(MockNonceDb::new());
    let address = Address::random();
    let state = Arc::new(NonceManagerState::new(db.clone(), address));
    let manager = NonceManager {
        address,
        state: state.clone(),
        _nonce_updater: Default::default(),
    };

    let uuid1 = TransactionUuid::random();
    let uuid2 = TransactionUuid::random();
    let nonce = U256::from(5);
    db.store_nonce_status_by_nonce_and_signer_address(&nonce, &address, &NonceStatus::Taken(uuid1))
        .await
        .unwrap();

    let tx = make_tx(uuid2, TransactionStatus::PendingInclusion, nonce, address);

    // Try to update to Taken with uuid2 (should error)
    let result = manager.update_nonce_status(&tx, &tx.status).await;
    assert!(result.is_err());
}

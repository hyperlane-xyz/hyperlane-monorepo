use ethers_core::types::Address;

use hyperlane_core::U256;

use crate::adapter::EthereumTxPrecursor;
use crate::tests::test_utils::tmp_dbs;
use crate::transaction::{
    DropReason, Transaction, TransactionStatus, TransactionUuid, VmSpecificTxData,
};

use super::super::NonceManagerState;

#[allow(deprecated)]
fn make_tx(uuid: TransactionUuid, status: TransactionStatus) -> Transaction {
    use ethers_core::abi::Function;
    let precursor = EthereumTxPrecursor {
        tx: Default::default(),
        function: Function {
            name: "".to_string(),
            inputs: vec![],
            outputs: vec![],
            constant: None,
            state_mutability: Default::default(),
        },
    };
    Transaction {
        uuid,
        tx_hashes: vec![],
        vm_specific_data: VmSpecificTxData::Evm(precursor),
        payload_details: vec![],
        status,
        submission_attempts: 0,
        creation_timestamp: Default::default(),
        last_submission_attempt: None,
    }
}

#[tokio::test]
async fn test_identify_next_nonce_no_finalized_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db, tx_db, address);

    // If finalized_nonce is None, should return upper_nonce
    let upper_nonce = U256::from(5);
    let result = state.identify_next_nonce(None, upper_nonce).await.unwrap();
    assert_eq!(result, upper_nonce);
}

#[tokio::test]
async fn test_identify_next_nonce_first_untracked_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db.clone(), tx_db.clone(), address);

    // finalized_nonce = 2, upper_nonce = 5
    // 2: tracked, 3: not tracked, should return 3
    let finalized_nonce = U256::from(2);
    let upper_nonce = U256::from(5);

    let uuid = TransactionUuid::random();
    state
        .set_tracked_tx_uuid(&finalized_nonce, &uuid)
        .await
        .unwrap();

    // 3 is not tracked
    let result = state
        .identify_next_nonce(Some(finalized_nonce), upper_nonce)
        .await
        .unwrap();
    assert_eq!(result, finalized_nonce);
}

#[tokio::test]
async fn test_identify_next_nonce_first_freed_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db.clone(), tx_db.clone(), address);

    // finalized_nonce = 1, upper_nonce = 4
    // 1: tracked, 2: tracked (Freed), 3: tracked (Taken)
    let finalized_nonce = U256::from(1);
    let upper_nonce = U256::from(4);

    let uuid1 = TransactionUuid::random();
    let uuid2 = TransactionUuid::random();
    let uuid3 = TransactionUuid::random();

    // 1: tracked, but transaction exists and is not Freed
    state
        .set_tracked_tx_uuid(&U256::from(1), &uuid1)
        .await
        .unwrap();
    let tx1 = make_tx(uuid1, TransactionStatus::PendingInclusion);
    state.tx_db.store_transaction_by_uuid(&tx1).await.unwrap();

    // 2: tracked, transaction is Freed
    state
        .set_tracked_tx_uuid(&U256::from(2), &uuid2)
        .await
        .unwrap();
    let tx2 = make_tx(
        uuid2,
        TransactionStatus::Dropped(DropReason::DroppedByChain),
    );
    state.tx_db.store_transaction_by_uuid(&tx2).await.unwrap();

    // 3: tracked, transaction is Taken
    state
        .set_tracked_tx_uuid(&U256::from(3), &uuid3)
        .await
        .unwrap();
    let tx3 = make_tx(uuid3, TransactionStatus::PendingInclusion);
    state.tx_db.store_transaction_by_uuid(&tx3).await.unwrap();

    // Should return 2 (Freed)
    let result = state
        .identify_next_nonce(Some(finalized_nonce), upper_nonce)
        .await
        .unwrap();
    assert_eq!(result, U256::from(2));
}

#[tokio::test]
async fn test_identify_next_nonce_non_existing_tracked_tx() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db.clone(), tx_db, address);

    // finalized_nonce = 0, upper_nonce = 2
    // 0: tracked, but transaction does not exist
    let finalized_nonce = U256::from(0);
    let upper_nonce = U256::from(2);

    let uuid = TransactionUuid::random();
    state
        .set_tracked_tx_uuid(&U256::from(0), &uuid)
        .await
        .unwrap();
    // Do not store transaction for uuid

    // Should return 0 (since tracked tx does not exist, should break and return current)
    let result = state
        .identify_next_nonce(Some(finalized_nonce), upper_nonce)
        .await
        .unwrap();
    assert_eq!(result, U256::from(0));
}

#[tokio::test]
async fn test_identify_next_nonce_all_taken() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db.clone(), tx_db.clone(), address);

    // finalized_nonce = 0, upper_nonce = 3
    // 0: tracked (Taken), 1: tracked (Taken), 2: tracked (Taken)
    let finalized_nonce = U256::from(0);
    let upper_nonce = U256::from(3);

    for i in 0..3 {
        let uuid = TransactionUuid::random();
        state
            .set_tracked_tx_uuid(&U256::from(i), &uuid)
            .await
            .unwrap();
        let tx = make_tx(uuid, TransactionStatus::PendingInclusion);
        state.tx_db.store_transaction_by_uuid(&tx).await.unwrap();
    }

    // Should return 3 (upper_nonce, since all are taken)
    let result = state
        .identify_next_nonce(Some(finalized_nonce), upper_nonce)
        .await
        .unwrap();
    assert_eq!(result, upper_nonce);
}

#[tokio::test]
async fn test_identify_next_nonce_gap_in_tracked_nonces() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db.clone(), tx_db.clone(), address);

    // finalized_nonce = 0, upper_nonce = 4
    // 0: tracked (Taken), 1: not tracked, 2: tracked (Taken), 3: not tracked
    let finalized_nonce = U256::from(0);
    let upper_nonce = U256::from(4);

    let uuid0 = TransactionUuid::random();
    state
        .set_tracked_tx_uuid(&U256::from(0), &uuid0)
        .await
        .unwrap();
    let tx0 = make_tx(uuid0, TransactionStatus::PendingInclusion);
    state.tx_db.store_transaction_by_uuid(&tx0).await.unwrap();

    let uuid2 = TransactionUuid::random();
    state
        .set_tracked_tx_uuid(&U256::from(2), &uuid2)
        .await
        .unwrap();
    let tx2 = make_tx(uuid2, TransactionStatus::PendingInclusion);
    state.tx_db.store_transaction_by_uuid(&tx2).await.unwrap();

    // Should return 1 (first not tracked)
    let result = state
        .identify_next_nonce(Some(finalized_nonce), upper_nonce)
        .await
        .unwrap();
    assert_eq!(result, U256::from(1));
}

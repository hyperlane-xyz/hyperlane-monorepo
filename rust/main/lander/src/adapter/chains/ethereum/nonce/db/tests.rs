use ethers_core::types::Address;

use hyperlane_core::U256;

use crate::tests::test_utils::tmp_dbs;
use crate::transaction::TransactionUuid;

use super::super::super::nonce::status::NonceStatus;

#[tokio::test]
async fn test_nonce_db_finalized_and_upper() {
    let (_, _, nonce_db) = tmp_dbs();
    let signer = Address::random();
    let nonce = U256::from(42);

    // Initially, should be None
    assert_eq!(
        nonce_db
            .retrieve_finalized_nonce_by_signer_address(&signer)
            .await
            .unwrap(),
        None
    );
    nonce_db
        .store_finalized_nonce_by_signer_address(&signer, &nonce)
        .await
        .unwrap();
    assert_eq!(
        nonce_db
            .retrieve_finalized_nonce_by_signer_address(&signer)
            .await
            .unwrap(),
        Some(nonce)
    );

    assert_eq!(
        nonce_db
            .retrieve_upper_nonce_by_signer_address(&signer)
            .await
            .unwrap(),
        None
    );
    nonce_db
        .store_upper_nonce_by_signer_address(&signer, &nonce)
        .await
        .unwrap();
    assert_eq!(
        nonce_db
            .retrieve_upper_nonce_by_signer_address(&signer)
            .await
            .unwrap(),
        Some(nonce)
    );
}

#[tokio::test]
async fn test_transaction_uuid_by_nonce_and_signer_address() {
    let (_, _, nonce_db) = tmp_dbs();
    let signer = Address::random();
    let nonce = U256::from(77);
    let tx_uuid = TransactionUuid::random();

    // Should be None initially
    assert_eq!(
        nonce_db
            .retrieve_transaction_uuid_by_nonce_and_signer_address(&nonce, &signer)
            .await
            .unwrap(),
        None
    );

    // Store and retrieve
    nonce_db
        .store_transaction_uuid_by_nonce_and_signer_address(&nonce, &signer, &tx_uuid)
        .await
        .unwrap();
    assert_eq!(
        nonce_db
            .retrieve_transaction_uuid_by_nonce_and_signer_address(&nonce, &signer)
            .await
            .unwrap(),
        Some(tx_uuid)
    );
}

// Optionally, test edge cases for overwriting and multiple keys
#[tokio::test]
async fn test_transaction_uuid_overwrite_and_multiple_keys() {
    let (_, _, nonce_db) = tmp_dbs();
    let signer1 = Address::random();
    let signer2 = Address::random();
    let nonce1 = U256::from(1);
    let nonce2 = U256::from(2);
    let tx_uuid1 = TransactionUuid::random();
    let tx_uuid2 = TransactionUuid::random();

    // Store for (nonce1, signer1)
    nonce_db
        .store_transaction_uuid_by_nonce_and_signer_address(&nonce1, &signer1, &tx_uuid1)
        .await
        .unwrap();
    // Overwrite for (nonce1, signer1)
    nonce_db
        .store_transaction_uuid_by_nonce_and_signer_address(&nonce1, &signer1, &tx_uuid2)
        .await
        .unwrap();
    // Store for (nonce2, signer2)
    nonce_db
        .store_transaction_uuid_by_nonce_and_signer_address(&nonce2, &signer2, &tx_uuid1)
        .await
        .unwrap();

    // Should get the overwritten value for (nonce1, signer1)
    assert_eq!(
        nonce_db
            .retrieve_transaction_uuid_by_nonce_and_signer_address(&nonce1, &signer1)
            .await
            .unwrap(),
        Some(tx_uuid2)
    );
    // Should get the correct value for (nonce2, signer2)
    assert_eq!(
        nonce_db
            .retrieve_transaction_uuid_by_nonce_and_signer_address(&nonce2, &signer2)
            .await
            .unwrap(),
        Some(tx_uuid1)
    );
}

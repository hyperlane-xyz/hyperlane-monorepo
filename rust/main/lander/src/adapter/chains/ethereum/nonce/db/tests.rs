use ethers_core::types::Address;

use hyperlane_core::U256;

use crate::dispatcher::test_utils::tmp_dbs;
use crate::transaction::TransactionUuid;

use super::super::super::nonce::state::NonceStatus;

#[tokio::test]
async fn test_nonce_db_lowest_and_upper() {
    let (_, _, nonce_db) = tmp_dbs();
    let signer = Address::random();
    let nonce = U256::from(42);

    // Initially, should be None
    assert_eq!(
        nonce_db
            .retrieve_lowest_available_nonce_by_signer_address(&signer)
            .await
            .unwrap(),
        None
    );
    nonce_db
        .store_lowest_available_nonce_by_signer_address(&signer, &nonce)
        .await
        .unwrap();
    assert_eq!(
        nonce_db
            .retrieve_lowest_available_nonce_by_signer_address(&signer)
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
async fn test_nonce_db_status() {
    let (_, _, nonce_db) = tmp_dbs();
    let signer = Address::random();
    let nonce = U256::from(7);
    let tx_uuid = TransactionUuid::random();
    let status = NonceStatus::Committed(tx_uuid);

    assert_eq!(
        nonce_db
            .retrieve_nonce_status_by_nonce_and_signer_address(&nonce, &signer)
            .await
            .unwrap(),
        None
    );
    nonce_db
        .store_nonce_status_by_nonce_and_signer_address(&nonce, &signer, &status)
        .await
        .unwrap();
    assert_eq!(
        nonce_db
            .retrieve_nonce_status_by_nonce_and_signer_address(&nonce, &signer)
            .await
            .unwrap(),
        Some(status)
    );
}

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

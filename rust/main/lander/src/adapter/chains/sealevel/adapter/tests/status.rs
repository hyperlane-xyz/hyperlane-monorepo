use crate::{
    adapter::{
        chains::sealevel::adapter::tests::common::{adapter, transaction},
        AdaptsChain,
    },
    transaction::TransactionStatus,
};

#[tokio::test]
async fn test_tx_status() {
    // given
    let adapter = adapter();
    let transaction = transaction();

    // when
    let result = adapter.tx_status(&transaction).await;

    // then
    assert!(result.is_ok());
    let status = result.unwrap();
    assert!(matches!(status, TransactionStatus::Finalized));
}

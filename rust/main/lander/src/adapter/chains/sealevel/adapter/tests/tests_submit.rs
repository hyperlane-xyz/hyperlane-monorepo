use crate::adapter::{
    chains::sealevel::{
        adapter::tests::tests_common::{adapter, payload, precursor},
        transaction::TransactionFactory,
    },
    AdaptsChain,
};

#[tokio::test]
async fn test_submit() {
    // given
    let adapter = adapter();
    let mut transaction = TransactionFactory::build(&payload(), precursor());

    // when
    let result = adapter.submit(&mut transaction).await;

    // then
    assert!(result.is_ok());
}

use crate::adapter::{
    chains::sealevel::{
        adapter::tests::tests_common::{adapter, payload, precursor},
        transaction::TransactionFactory,
    },
    AdaptsChain,
};

#[tokio::test]
async fn test_simulate_tx() {
    // given
    let adapter = adapter();
    let transaction = TransactionFactory::build(&payload(), precursor());

    // when
    let simulated = adapter.simulate_tx(&transaction).await.unwrap();

    // then
    assert!(simulated);
}

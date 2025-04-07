use crate::chain_tx_adapter::chains::sealevel::adapter::tests::common::{
    adapter, payload, precursor,
};
use crate::chain_tx_adapter::chains::sealevel::transaction::TransactionFactory;
use crate::chain_tx_adapter::AdaptsChain;

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

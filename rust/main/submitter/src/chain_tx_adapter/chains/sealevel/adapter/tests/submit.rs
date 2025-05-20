use crate::chain_tx_adapter::chains::sealevel::adapter::tests::common::{
    adapter, payload, precursor,
};
use crate::chain_tx_adapter::chains::sealevel::transaction::TransactionFactory;
use crate::chain_tx_adapter::AdaptsChain;

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

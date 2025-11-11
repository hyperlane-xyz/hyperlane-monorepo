use crate::adapter::AdaptsChain;

use super::super::TransactionFactory;
use super::tests_common::{adapter, payload, precursor};

#[tokio::test]
async fn test_simulate_tx() {
    // given
    let adapter = adapter();
    let mut transaction = TransactionFactory::build(&payload(), precursor());

    // when
    let simulated = adapter.simulate_tx(&mut transaction).await.unwrap();

    // then
    assert!(simulated.is_empty());
}

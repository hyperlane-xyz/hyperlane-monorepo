use crate::adapter::AdaptsChain;

use super::super::TransactionFactory;
use super::tests_common::{adapter, payload, precursor};

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

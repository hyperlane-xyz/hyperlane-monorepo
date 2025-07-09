use hyperlane_core::U256;

use crate::adapter::AdaptsChain;
use crate::payload::FullPayload;

use super::tests_common::{adapter, payload, GAS_LIMIT};

#[tokio::test]
async fn test_estimate_gas_limit() {
    // given
    let adapter = adapter();
    let payload = payload();

    let expected = U256::from(GAS_LIMIT);

    // when
    let result = adapter.estimate_gas_limit(&payload).await;

    // then
    assert!(result.is_ok());
    assert_eq!(expected, result.unwrap().unwrap());
}

use hyperlane_core::{FixedPointNumber, U256};

use crate::adapter::AdaptsChain;
use crate::payload::FullPayload;

use super::tests_common::{adapter, payload, GAS_LIMIT};

#[tokio::test]
async fn test_estimate_gas_limit() {
    // given
    let adapter = adapter();
    let payload = payload();

    let expected_gas_limit = U256::from(GAS_LIMIT);

    // when
    let result = adapter.estimate_gas_limit(&payload).await;

    // then
    assert!(result.is_ok());
    let estimate = result.unwrap();
    assert_eq!(expected_gas_limit, estimate.gas_limit);
    assert_eq!(FixedPointNumber::zero(), estimate.gas_price);
    assert_eq!(None, estimate.l2_gas_limit);
}

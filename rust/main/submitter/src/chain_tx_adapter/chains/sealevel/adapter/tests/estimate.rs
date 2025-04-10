use hyperlane_core::U256;

use crate::chain_tx_adapter::chains::sealevel::adapter::tests::common::{
    adapter, payload, GAS_LIMIT,
};
use crate::chain_tx_adapter::AdaptsChain;
use crate::payload::FullPayload;

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

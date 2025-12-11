use ethers::types::{TransactionReceipt, H256};
use ethers_prometheus::json_rpc_client::{JsonRpcBlockGetter, BLOCK_NUMBER_RPC};
use hyperlane_core::rpc_clients::test::ProviderMock;
use hyperlane_core::rpc_clients::FallbackProviderBuilder;

use super::mock::*;
use super::*;

impl<C> EthereumFallbackProvider<C, JsonRpcBlockGetter<C>>
where
    C: JsonRpcClient<Error = HttpClientError>
        + PrometheusConfigExt
        + Into<JsonRpcBlockGetter<C>>
        + Clone,
    JsonRpcBlockGetter<C>: BlockNumberGetter,
{
    async fn fallback_test_call(&self) -> u64 {
        self.request::<_, u64>(BLOCK_NUMBER_RPC, ()).await.unwrap()
    }

    async fn multicast_test_call(&self) -> Result<u64, ProviderError> {
        self.request::<_, u64>(METHOD_SEND_RAW_TRANSACTION, ())
            .await
    }

    async fn get_tx_receipt_test_call(&self) -> Result<Option<TransactionReceipt>, ProviderError> {
        self.request::<_, Option<TransactionReceipt>>(
            METHOD_GET_TRANSACTION_RECEIPT,
            H256::random(),
        )
        .await
    }
}

// Explanation of the test expected result:
// FutureUnordered builds internal queue and all futures are inserted into the queue in the order
//  they are added. On the first pass, FutureUnordered iterates through the queue in the order in
//  which the futures were pushed into it. Since the first future resolves into Poll::Ready, only
//  this future is polled.
// FutureUnordered does not guarantee that it will return the results from each future in the same
//  order as they were pushed into it. FutureUnordered will return the result of the first future
//  which becomes ready. It just happened in this test case that the first future is polled first
//  and provide results first.
#[tracing_test::traced_test]
#[tokio::test]
async fn test_multicast_first_provider_succeeds_immediately() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];

    providers[0]
        .responses
        .send_raw_transaction
        .lock()
        .unwrap()
        .push_back(Some(1));
    providers[1]
        .responses
        .send_raw_transaction
        .lock()
        .unwrap()
        .push_back(Some(2));
    providers[2]
        .responses
        .send_raw_transaction
        .lock()
        .unwrap()
        .push_back(Some(3));

    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, false);
    let provider_id = ethereum_fallback_provider
        .multicast_test_call()
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 1);
    assert_eq!(provider_call_count, vec![1, 0, 0]);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_multicast_second_provider_succeeds_immediately() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];
    providers[1]
        .responses
        .send_raw_transaction
        .lock()
        .unwrap()
        .push_back(Some(2));
    providers[2]
        .responses
        .send_raw_transaction
        .lock()
        .unwrap()
        .push_back(Some(3));

    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, false);
    let provider_id = ethereum_fallback_provider
        .multicast_test_call()
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 2);
    assert_eq!(provider_call_count, vec![1, 1, 0]);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_multicast_third_provider_succeeds_immediately() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];
    providers[2]
        .responses
        .send_raw_transaction
        .lock()
        .unwrap()
        .push_back(Some(3));

    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, false);
    let provider_id = ethereum_fallback_provider
        .multicast_test_call()
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 3);
    assert_eq!(provider_call_count, vec![1, 1, 1]);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_multicast_first_provider_succeeds_slow() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(10))),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];
    providers[0]
        .responses
        .send_raw_transaction
        .lock()
        .unwrap()
        .push_back(Some(1));

    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, false);
    let provider_id = ethereum_fallback_provider
        .multicast_test_call()
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 1);
    assert_eq!(provider_call_count, vec![1, 1, 1]);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_multicast_second_provider_succeeds_slow() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(Some(Duration::from_millis(10))),
        EthereumProviderMock::new(None),
    ];
    providers[1]
        .responses
        .get_block_number
        .lock()
        .unwrap()
        .push_back(Some(2));
    providers[1]
        .responses
        .send_raw_transaction
        .lock()
        .unwrap()
        .push_back(Some(2));

    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, false);
    let provider_id = ethereum_fallback_provider
        .multicast_test_call()
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 2);
    assert_eq!(provider_call_count, vec![1, 1, 1]);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_multicast_first_provider_succeeds_slow_third_succeeds_immediately() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(10))),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];
    providers[0]
        .responses
        .send_raw_transaction
        .lock()
        .unwrap()
        .push_back(Some(1));
    providers[2]
        .responses
        .send_raw_transaction
        .lock()
        .unwrap()
        .push_back(Some(3));

    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, false);
    let provider_id = ethereum_fallback_provider
        .multicast_test_call()
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 3);
    assert_eq!(provider_call_count, vec![1, 1, 1]);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_multicast_first_provider_succeeds_slow_second_succeeds_quicker() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(10))),
        EthereumProviderMock::new(Some(Duration::from_millis(5))),
        EthereumProviderMock::new(None),
    ];
    providers[0]
        .responses
        .send_raw_transaction
        .lock()
        .unwrap()
        .push_back(Some(1));
    providers[1]
        .responses
        .send_raw_transaction
        .lock()
        .unwrap()
        .push_back(Some(2));

    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, false);
    let provider_id = ethereum_fallback_provider
        .multicast_test_call()
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 2);
    assert_eq!(provider_call_count, vec![1, 1, 1]);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_multicast_none_provider_succeeds() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, false);
    let result = ethereum_fallback_provider.multicast_test_call().await;
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert!(
        matches!(result, Err(ProviderError::JsonRpcClientError(_))),
        "results do not match"
    );
    assert_eq!(provider_call_count, vec![4, 4, 4]);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_fallback_first_provider_is_attempted() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];
    providers[0]
        .responses
        .get_block_number
        .lock()
        .unwrap()
        .push_back(Some(1));
    providers[1]
        .responses
        .get_block_number
        .lock()
        .unwrap()
        .push_back(Some(2));
    providers[2]
        .responses
        .get_block_number
        .lock()
        .unwrap()
        .push_back(Some(3));

    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, false);
    let provider_id = ethereum_fallback_provider.fallback_test_call().await;
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 1);
    assert_eq!(provider_call_count, vec![1, 0, 0]);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_fallback_one_stalled_provider() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(10))),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];
    providers[0]
        .responses
        .get_block_number
        .lock()
        .unwrap()
        .push_back(Some(1));
    providers[1]
        .responses
        .get_block_number
        .lock()
        .unwrap()
        .push_back(Some(2));
    providers[2]
        .responses
        .get_block_number
        .lock()
        .unwrap()
        .push_back(Some(3));

    let fallback_provider = fallback_provider_builder
        .add_providers(providers)
        .with_max_block_time(Duration::from_secs(0))
        .build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, false);
    let provider_id = ethereum_fallback_provider.fallback_test_call().await;
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 1);
    // The stalled provider is moved from 0th place to 2nd place in `provider_call_count
    // The value 2 is explained by how `handle_stalled_provider` is implemented:
    // we used the same kind of request there as in implementation of mock providers.
    assert_eq!(provider_call_count, vec![0, 0, 2]);
}

// TODO: make `categorize_client_response` generic over `ProviderError` to allow testing
// two stalled providers (so that the for loop in `request` doesn't stop after the first provider)

// Tests for fallback_transaction_receipt behavior

/// Test that a provider returning null for transaction receipt is called only once
#[tracing_test::traced_test]
#[tokio::test]
async fn test_fallback_tx_receipt_null_called_once() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];

    // First provider returns null (None in the mock means Ok(null))
    providers[0]
        .responses
        .get_tx_receipt
        .lock()
        .unwrap()
        .push_back(None);

    // Second provider returns a successful receipt
    let mut receipt = TransactionReceipt::default();
    receipt.block_number = Some(100.into());
    providers[1]
        .responses
        .get_tx_receipt
        .lock()
        .unwrap()
        .push_back(Some(receipt.clone()));

    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, true);

    let result = ethereum_fallback_provider
        .get_tx_receipt_test_call()
        .await
        .unwrap();

    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;

    // First provider should be called only once (null is not retried)
    // Second provider should be called once and return the receipt
    assert_eq!(provider_call_count, vec![1, 1, 0]);
    assert_eq!(result.unwrap().block_number, Some(100.into()));
}

/// Test that a provider returning errors gets called multiple times before giving up
#[tracing_test::traced_test]
#[tokio::test]
async fn test_fallback_tx_receipt_error_retried_multiple_times() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];

    // Both providers return errors (no responses set up, so they return errors)
    // The mock's dummy_error_return_value() will be used
    // With 2 providers, each will be called twice (total 4 errors before giving up)

    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, true);

    let result = ethereum_fallback_provider.get_tx_receipt_test_call().await;

    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;

    // Each provider should be called 2 times (across 2 retry rounds, total 4 errors)
    assert_eq!(provider_call_count, vec![2, 2]);
    assert!(
        matches!(result, Err(ProviderError::JsonRpcClientError(_))),
        "Expected error result"
    );
}

/// Test provider successfully returns receipt immediately
#[tracing_test::traced_test]
#[tokio::test]
async fn test_fallback_tx_receipt_immediate_success() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];

    let mut receipt = TransactionReceipt::default();
    receipt.block_number = Some(200.into());

    // Provider 0 returns receipt immediately on first call
    providers[0]
        .responses
        .get_tx_receipt
        .lock()
        .unwrap()
        .push_back(Some(receipt.clone()));

    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, true);

    let result = ethereum_fallback_provider
        .get_tx_receipt_test_call()
        .await
        .unwrap();

    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;

    // Provider 0: called once and returns receipt
    // Provider 1: not called because provider 0 succeeded
    assert_eq!(provider_call_count, vec![1, 0]);
    assert_eq!(result.unwrap().block_number, Some(200.into()));
}

/// Test multiple providers: first null, second succeeds
#[tracing_test::traced_test]
#[tokio::test]
async fn test_fallback_tx_receipt_null_then_success() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];

    // First provider: returns null (not retried)
    providers[0]
        .responses
        .get_tx_receipt
        .lock()
        .unwrap()
        .push_back(None);

    // Second provider: returns success
    let mut receipt = TransactionReceipt::default();
    receipt.block_number = Some(300.into());
    providers[1]
        .responses
        .get_tx_receipt
        .lock()
        .unwrap()
        .push_back(Some(receipt.clone()));

    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, true);

    let result = ethereum_fallback_provider
        .get_tx_receipt_test_call()
        .await
        .unwrap();

    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;

    // First provider: called once (null, not retried)
    // Second provider: called once (success)
    // Third provider: not called because second provider succeeded
    assert_eq!(provider_call_count, vec![1, 1, 0]);
    assert_eq!(result.unwrap().block_number, Some(300.into()));
}

/// Test mixed: null, error, success
#[tracing_test::traced_test]
#[tokio::test]
async fn test_fallback_tx_receipt_mixed_null_error_success() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];

    // First provider returns null (not retried)
    providers[0]
        .responses
        .get_tx_receipt
        .lock()
        .unwrap()
        .push_back(None);

    // Second provider: no response (returns error on first call)
    // Third provider returns success
    let mut receipt = TransactionReceipt::default();
    receipt.block_number = Some(400.into());
    providers[2]
        .responses
        .get_tx_receipt
        .lock()
        .unwrap()
        .push_back(Some(receipt.clone()));

    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, true);

    let result = ethereum_fallback_provider
        .get_tx_receipt_test_call()
        .await
        .unwrap();

    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;

    // First provider: called once (null, not retried)
    // Second provider: called once (error)
    // Third provider: called once (success)
    assert_eq!(provider_call_count, vec![1, 1, 1]);
    assert_eq!(result.unwrap().block_number, Some(400.into()));
}

/// Test all providers return null (should fail)
#[tracing_test::traced_test]
#[tokio::test]
async fn test_fallback_tx_receipt_all_null() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];

    // All providers return null
    providers[0]
        .responses
        .get_tx_receipt
        .lock()
        .unwrap()
        .push_back(None);
    providers[1]
        .responses
        .get_tx_receipt
        .lock()
        .unwrap()
        .push_back(None);
    providers[2]
        .responses
        .get_tx_receipt
        .lock()
        .unwrap()
        .push_back(None);

    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, true);

    let result = ethereum_fallback_provider.get_tx_receipt_test_call().await;

    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;

    // All providers called once (null is not retried)
    assert_eq!(provider_call_count, vec![1, 1, 1]);
    assert!(
        matches!(result, Err(ProviderError::JsonRpcClientError(_))),
        "Expected AllProvidersFailed error"
    );
}

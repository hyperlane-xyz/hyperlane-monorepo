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
    matches!(result, Err(ProviderError::JsonRpcClientError(_)));
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

#[tracing_test::traced_test]
#[tokio::test]
async fn test_fallback_no_tx_receipt_no_rotate() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(10))),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];
    providers[2]
        .responses
        .get_tx_receipt
        .lock()
        .unwrap()
        .push_back(Some(TransactionReceipt::default()));
    let fallback_provider = fallback_provider_builder
        .add_providers(providers)
        .with_max_block_time(Duration::from_secs(0))
        .build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, false);

    let before_provider_priorities =
        ProviderMock::get_priorities(&ethereum_fallback_provider).await;

    let tx_receipt: Option<TransactionReceipt> = ethereum_fallback_provider
        .fallback(METHOD_GET_TRANSACTION_RECEIPT, H256::zero())
        .await
        .expect("Failed to get tx receipt");
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;

    let after_provider_priorities = ProviderMock::get_priorities(&ethereum_fallback_provider).await;

    assert_eq!(tx_receipt, Some(TransactionReceipt::default()));
    assert_eq!(provider_call_count, vec![2, 2, 2]);

    let expected: Vec<_> = before_provider_priorities
        .into_iter()
        .map(|p| p.index)
        .collect();
    let actual: Vec<_> = after_provider_priorities
        .into_iter()
        .map(|p| p.index)
        .collect();

    assert_eq!(expected, actual);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_fallback_no_tx_receipt_rotate() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(10))),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];
    providers[2]
        .responses
        .get_tx_receipt
        .lock()
        .unwrap()
        .push_back(Some(TransactionReceipt::default()));
    let fallback_provider = fallback_provider_builder
        .add_providers(providers)
        .with_max_block_time(Duration::from_secs(0))
        .build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, true);

    let before_provider_priorities =
        ProviderMock::get_priorities(&ethereum_fallback_provider).await;

    let tx_receipt: Option<TransactionReceipt> = ethereum_fallback_provider
        .fallback(METHOD_GET_TRANSACTION_RECEIPT, H256::zero())
        .await
        .expect("Failed to get tx receipt");
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;

    assert_eq!(tx_receipt, Some(TransactionReceipt::default()));
    assert_eq!(provider_call_count, vec![2, 2, 2]);

    let after_provider_priorities = ProviderMock::get_priorities(&ethereum_fallback_provider).await;

    let expected_priorities = [
        before_provider_priorities[2],
        before_provider_priorities[0],
        before_provider_priorities[1],
    ];
    let expected: Vec<_> = expected_priorities.into_iter().map(|p| p.index).collect();
    let actual: Vec<_> = after_provider_priorities
        .into_iter()
        .map(|p| p.index)
        .collect();
    assert_eq!(expected, actual);
}
// TODO: make `categorize_client_response` generic over `ProviderError` to allow testing
// two stalled providers (so that the for loop in `request` doesn't stop after the first provider)

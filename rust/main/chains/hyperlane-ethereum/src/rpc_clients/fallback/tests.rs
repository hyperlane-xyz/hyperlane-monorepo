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
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];
    // Push a bunch of responses so we don't run out
    for i in 0..2 {
        for _ in 0..30 {
            providers[i]
                .responses
                .get_block_number
                .lock()
                .unwrap()
                .push_back(Some(3));
            providers[i]
                .responses
                .get_tx_receipt
                .lock()
                .unwrap()
                .push_back(None);
        }
    }
    for _ in 0..30 {
        providers[2]
            .responses
            .get_block_number
            .lock()
            .unwrap()
            .push_back(Some(3));
        providers[2]
            .responses
            .get_tx_receipt
            .lock()
            .unwrap()
            .push_back(Some(TransactionReceipt::default()));
    }
    let fallback_provider = fallback_provider_builder
        .add_providers(providers)
        .with_max_block_time(Duration::from_secs(10))
        .build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, true);

    let before_provider_priorities =
        ProviderMock::get_priorities(&ethereum_fallback_provider).await;

    let expected: Vec<_> = vec![0, 1, 2];
    let actual: Vec<_> = before_provider_priorities
        .into_iter()
        .map(|p| p.index)
        .collect();
    assert_eq!(expected, actual);

    let tx_receipt: Option<TransactionReceipt> = ethereum_fallback_provider
        .request(METHOD_GET_TRANSACTION_RECEIPT, H256::zero())
        .await
        .expect("Failed to get tx receipt");
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;

    assert_eq!(tx_receipt, Some(TransactionReceipt::default()));
    assert_eq!(provider_call_count, vec![1, 1, 1]);

    let after_provider_priorities = ProviderMock::get_priorities(&ethereum_fallback_provider).await;

    let expected: Vec<_> = vec![2, 0, 1];
    let actual: Vec<_> = after_provider_priorities
        .into_iter()
        .map(|p| p.index)
        .collect();
    assert_eq!(expected, actual);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_fallback_all_providers_return_null_receipt_with_rotate() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];

    // All providers return None for transaction receipt
    for i in 0..3 {
        for _ in 0..30 {
            providers[i]
                .responses
                .get_block_number
                .lock()
                .unwrap()
                .push_back(Some(i as u64 + 1));
            providers[i]
                .responses
                .get_tx_receipt
                .lock()
                .unwrap()
                .push_back(None);
        }
    }

    let fallback_provider = fallback_provider_builder
        .add_providers(providers)
        .with_max_block_time(Duration::from_secs(10))
        .build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, true);

    let result: Result<Option<TransactionReceipt>, _> = ethereum_fallback_provider
        .request(METHOD_GET_TRANSACTION_RECEIPT, H256::zero())
        .await;

    // Should fail since all providers returned null
    assert!(matches!(result, Err(ProviderError::JsonRpcClientError(_))));

    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;

    // Each provider should have been tried multiple times due to retries
    assert!(provider_call_count.iter().all(|&count| count > 0));
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_fallback_first_provider_null_receipt_rotates_immediately() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];

    // First provider returns None, second provider returns a receipt
    for _ in 0..10 {
        providers[0]
            .responses
            .get_block_number
            .lock()
            .unwrap()
            .push_back(Some(1));
        providers[0]
            .responses
            .get_tx_receipt
            .lock()
            .unwrap()
            .push_back(None);

        providers[1]
            .responses
            .get_block_number
            .lock()
            .unwrap()
            .push_back(Some(2));
        providers[1]
            .responses
            .get_tx_receipt
            .lock()
            .unwrap()
            .push_back(Some(TransactionReceipt::default()));

        providers[2]
            .responses
            .get_block_number
            .lock()
            .unwrap()
            .push_back(Some(3));
        providers[2]
            .responses
            .get_tx_receipt
            .lock()
            .unwrap()
            .push_back(Some(TransactionReceipt::default()));
    }

    let fallback_provider = fallback_provider_builder
        .add_providers(providers)
        .with_max_block_time(Duration::from_secs(10))
        .build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, true);

    let before_priorities = ProviderMock::get_priorities(&ethereum_fallback_provider).await;
    let before_indices: Vec<_> = before_priorities.iter().map(|p| p.index).collect();
    assert_eq!(before_indices, vec![0, 1, 2]);

    let tx_receipt: Option<TransactionReceipt> = ethereum_fallback_provider
        .request(METHOD_GET_TRANSACTION_RECEIPT, H256::zero())
        .await
        .expect("Failed to get tx receipt");

    assert_eq!(tx_receipt, Some(TransactionReceipt::default()));

    let after_priorities = ProviderMock::get_priorities(&ethereum_fallback_provider).await;
    let after_indices: Vec<_> = after_priorities.iter().map(|p| p.index).collect();

    // Provider 0 should be deprioritized, provider 1 should be first
    assert_eq!(after_indices, vec![1, 2, 0]);

    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    // Provider 0 and 1 should have been called (others may be called by handle_stalled_provider)
    assert!(provider_call_count[0] >= 1);
    assert!(provider_call_count[1] >= 1 || provider_call_count[2] >= 1);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_fallback_rotation_persists_across_multiple_requests() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];

    // Provider 0 always returns None
    // Provider 1 and 2 return receipts
    for _ in 0..30 {
        providers[0]
            .responses
            .get_block_number
            .lock()
            .unwrap()
            .push_back(Some(1));
        providers[0]
            .responses
            .get_tx_receipt
            .lock()
            .unwrap()
            .push_back(None);

        for i in 1..3 {
            providers[i]
                .responses
                .get_block_number
                .lock()
                .unwrap()
                .push_back(Some(i as u64 + 1));
            providers[i]
                .responses
                .get_tx_receipt
                .lock()
                .unwrap()
                .push_back(Some(TransactionReceipt::default()));
        }
    }

    let fallback_provider = fallback_provider_builder
        .add_providers(providers)
        .with_max_block_time(Duration::from_secs(10))
        .build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, true);

    // First request: should cause rotation
    let _tx_receipt1: Option<TransactionReceipt> = ethereum_fallback_provider
        .request(METHOD_GET_TRANSACTION_RECEIPT, H256::zero())
        .await
        .expect("Failed to get tx receipt");

    let after_first_priorities = ProviderMock::get_priorities(&ethereum_fallback_provider).await;
    let after_first_indices: Vec<_> = after_first_priorities.iter().map(|p| p.index).collect();
    assert_eq!(after_first_indices, vec![1, 2, 0]);

    // Second request: should use rotated priorities and succeed immediately with provider 1
    let _tx_receipt2: Option<TransactionReceipt> = ethereum_fallback_provider
        .request(METHOD_GET_TRANSACTION_RECEIPT, H256::zero())
        .await
        .expect("Failed to get tx receipt");

    let after_second_priorities = ProviderMock::get_priorities(&ethereum_fallback_provider).await;
    let after_second_indices: Vec<_> = after_second_priorities.iter().map(|p| p.index).collect();
    // Priorities should remain the same since provider 1 succeeded
    assert_eq!(after_second_indices, vec![1, 2, 0]);

    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    // First request: provider 0 tried and returned null, then another provider succeeded
    // Second request: should use the working provider immediately
    // Exact call counts can vary due to handle_stalled_provider checks
    assert!(
        provider_call_count[0] >= 1,
        "Provider 0 should be called at least once"
    );
    // At least one of the other providers should have been called multiple times
    assert!(
        provider_call_count.iter().filter(|&&c| c >= 2).count() >= 1,
        "At least one provider should be called multiple times"
    );
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_fallback_second_provider_null_receipt_rotates() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];

    // First provider returns None, second also returns None, third succeeds
    for _ in 0..10 {
        for i in 0..2 {
            providers[i]
                .responses
                .get_block_number
                .lock()
                .unwrap()
                .push_back(Some(i as u64 + 1));
            providers[i]
                .responses
                .get_tx_receipt
                .lock()
                .unwrap()
                .push_back(None);
        }
        providers[2]
            .responses
            .get_block_number
            .lock()
            .unwrap()
            .push_back(Some(3));
        providers[2]
            .responses
            .get_tx_receipt
            .lock()
            .unwrap()
            .push_back(Some(TransactionReceipt::default()));
    }

    let fallback_provider = fallback_provider_builder
        .add_providers(providers)
        .with_max_block_time(Duration::from_secs(10))
        .build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, true);

    let tx_receipt: Option<TransactionReceipt> = ethereum_fallback_provider
        .request(METHOD_GET_TRANSACTION_RECEIPT, H256::zero())
        .await
        .expect("Failed to get tx receipt");

    assert_eq!(tx_receipt, Some(TransactionReceipt::default()));

    let after_priorities = ProviderMock::get_priorities(&ethereum_fallback_provider).await;
    let after_indices: Vec<_> = after_priorities.iter().map(|p| p.index).collect();

    // Both provider 0 and 1 should be deprioritized, provider 2 should be first
    assert_eq!(after_indices, vec![2, 0, 1]);

    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    // All three providers tried once
    assert_eq!(provider_call_count, vec![1, 1, 1]);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_fallback_rotate_flag_controls_method_routing() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];

    // Setup providers to return None when using fallback_transaction_receipt
    for _ in 0..10 {
        providers[0]
            .responses
            .get_block_number
            .lock()
            .unwrap()
            .push_back(Some(1));
        providers[0]
            .responses
            .get_tx_receipt
            .lock()
            .unwrap()
            .push_back(None);

        providers[1]
            .responses
            .get_block_number
            .lock()
            .unwrap()
            .push_back(Some(2));
        providers[1]
            .responses
            .get_tx_receipt
            .lock()
            .unwrap()
            .push_back(Some(TransactionReceipt::default()));
    }

    // Test with rotate_no_transaction_receipt = false
    let fallback_provider_disabled = fallback_provider_builder
        .add_providers(providers)
        .with_max_block_time(Duration::from_secs(10))
        .build();
    let ethereum_fallback_provider_disabled =
        EthereumFallbackProvider::new(fallback_provider_disabled, false);

    let before_priorities_disabled =
        ProviderMock::get_priorities(&ethereum_fallback_provider_disabled).await;

    let tx_receipt_disabled: Option<TransactionReceipt> = ethereum_fallback_provider_disabled
        .fallback(METHOD_GET_TRANSACTION_RECEIPT, H256::zero())
        .await
        .expect("Failed to get tx receipt");

    // With flag disabled, it should use regular fallback which accepts null as success
    assert_eq!(tx_receipt_disabled, None);

    let after_priorities_disabled =
        ProviderMock::get_priorities(&ethereum_fallback_provider_disabled).await;
    let before_indices: Vec<_> = before_priorities_disabled.iter().map(|p| p.index).collect();
    let after_indices: Vec<_> = after_priorities_disabled.iter().map(|p| p.index).collect();

    // Priorities should not change with flag disabled
    assert_eq!(before_indices, after_indices);
}

// TODO: make `categorize_client_response` generic over `ProviderError` to allow testing
// two stalled providers (so that the for loop in `request` doesn't stop after the first provider)

use ethers::types::{TransactionReceipt, H256};
use ethers_prometheus::json_rpc_client::{JsonRpcBlockGetter, BLOCK_NUMBER_RPC};
use hyperlane_core::rpc_clients::test::ProviderMock;
use hyperlane_core::rpc_clients::FallbackProviderBuilder;
use hyperlane_metric::prometheus_metric::PrometheusClientMetricsBuilder;
use prometheus::{HistogramOpts, HistogramVec, IntCounterVec, Opts};
use serde_json::json;

use super::mock::*;
use super::*;

impl<C> EthereumFallbackProvider<C, JsonRpcBlockGetter<C>>
where
    C: JsonRpcClient<Error = HttpClientError>
        + PrometheusConfigExt
        + Into<JsonRpcBlockGetter<C>>
        + Clone
        + 'static,
    JsonRpcBlockGetter<C>: BlockNumberGetter + 'static,
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

    async fn get_block_by_hash_test_call(&self) -> Result<u64, ProviderError> {
        self.request::<_, u64>(
            METHOD_GET_BLOCK_BY_HASH,
            json!([format!("0x{}", "11".repeat(32)), false]),
        )
        .await
    }

    async fn immutable_call_test_call(&self) -> Result<u64, ProviderError> {
        self.request::<_, u64>(METHOD_CALL, json!([{}, "finalized"]))
            .await
    }

    async fn finalized_balance_test_call(&self) -> Result<u64, ProviderError> {
        self.request::<_, u64>(METHOD_GET_BALANCE, json!(["0x1234", "finalized"]))
            .await
    }
}

fn hedge_config(delay: Duration, attempt_timeout: Duration) -> FallbackHedgeConfig {
    FallbackHedgeConfig {
        delay,
        attempt_timeout,
    }
}

fn push_read_response(provider: &EthereumProviderMock, response: MockReadResponse) {
    provider
        .responses
        .immutable_read
        .lock()
        .unwrap()
        .push_back(response);
}

fn test_hedge_metrics() -> (
    hyperlane_metric::prometheus_metric::PrometheusClientMetrics,
    IntCounterVec,
    HistogramVec,
) {
    let events = IntCounterVec::new(
        Opts::new("test_fallback_hedge_events", "test events"),
        &["chain", "method", "event"],
    )
    .unwrap();
    let durations = HistogramVec::new(
        HistogramOpts::new("test_fallback_hedge_duration", "test duration"),
        &["chain", "method", "winner"],
    )
    .unwrap();
    let metrics = PrometheusClientMetricsBuilder::default()
        .fallback_hedge_events(events.clone())
        .fallback_hedge_duration_seconds(durations.clone())
        .build()
        .unwrap();
    (metrics, events, durations)
}

#[test]
fn hedge_allowlist_requires_pinned_reads() {
    let block_hash = json!(format!("0x{}", "11".repeat(32)));

    for method in [
        METHOD_CHAIN_ID,
        METHOD_GET_BLOCK_BY_HASH,
        METHOD_GET_BALANCE,
        METHOD_GET_CODE,
        METHOD_GET_STORAGE_AT,
        METHOD_GET_PROOF,
    ] {
        assert!(is_hedgeable_method(method), "{method}");
    }

    assert!(is_hedgeable_read(METHOD_CHAIN_ID, &Value::Null));
    assert!(is_hedgeable_read(
        METHOD_GET_BLOCK_BY_HASH,
        &json!([block_hash, false])
    ));
    assert!(!is_hedgeable_read(
        "eth_getBlockByNumber",
        &json!(["safe", false])
    ));
    for method in [METHOD_GET_BALANCE, METHOD_GET_CODE] {
        assert!(!is_hedgeable_read(method, &json!(["0x1234", "finalized"])));
        assert!(is_hedgeable_read(
            method,
            &json!(["0x1234", { "blockHash": block_hash }])
        ));
        assert!(!is_hedgeable_read(method, &json!(["0x1234", "latest"])));
    }
    for method in [METHOD_GET_STORAGE_AT, METHOD_GET_PROOF] {
        assert!(!is_hedgeable_read(
            method,
            &json!(["0x1234", [], "finalized"])
        ));
        assert!(is_hedgeable_read(
            method,
            &json!(["0x1234", [], { "blockHash": block_hash }])
        ));
        assert!(!is_hedgeable_read(
            method,
            &json!(["0x1234", [], "pending"])
        ));
    }

    for selector in [
        json!("latest"),
        json!("pending"),
        json!("finalized"),
        json!({"blockHash": format!("0x{}", "11".repeat(32))}),
    ] {
        assert!(!is_hedgeable_read(METHOD_CALL, &json!([{}, selector])));
    }
    for excluded in [
        METHOD_SEND_RAW_TRANSACTION,
        METHOD_GET_TRANSACTION_RECEIPT,
        "eth_getLogs",
        "eth_getTransactionByHash",
        "eth_getTransactionCount",
        "eth_feeHistory",
        "eth_estimateGas",
    ] {
        assert!(!is_hedgeable_method(excluded), "{excluded}");
        assert!(!is_hedgeable_read(excluded, &json!([])), "{excluded}");
    }
}

#[tokio::test]
async fn finalized_tag_reads_preserve_primary_freshness() {
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(20))),
        EthereumProviderMock::new(None),
    ];
    push_read_response(&providers[0], MockReadResponse::Success(100));
    push_read_response(&providers[1], MockReadResponse::Success(99));
    let fallback = FallbackProviderBuilder::default()
        .add_providers(providers)
        .build();
    let provider = EthereumFallbackProvider::new(fallback, false).with_hedging(
        Some(hedge_config(
            Duration::from_millis(1),
            Duration::from_millis(100),
        )),
        None,
    );

    assert_eq!(provider.finalized_balance_test_call().await.unwrap(), 100);
    assert_eq!(ProviderMock::get_call_counts(&provider).await, vec![1, 0]);
}

#[tokio::test]
async fn hedged_read_uses_fast_secondary_after_grace() {
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_secs(5))),
        EthereumProviderMock::new(None),
    ];
    push_read_response(&providers[0], MockReadResponse::Success(1));
    push_read_response(&providers[1], MockReadResponse::Success(2));
    let fallback = FallbackProviderBuilder::default()
        .add_providers(providers)
        .build();
    let (metrics, events, durations) = test_hedge_metrics();
    let provider = EthereumFallbackProvider::new(fallback, false).with_hedging(
        Some(hedge_config(
            Duration::from_millis(10),
            Duration::from_millis(100),
        )),
        Some(metrics),
    );

    assert_eq!(provider.get_block_by_hash_test_call().await.unwrap(), 2);
    assert_eq!(
        events
            .with_label_values(&["test_chain", METHOD_GET_BLOCK_BY_HASH, "start"])
            .get(),
        1
    );
    assert_eq!(
        events
            .with_label_values(&["test_chain", METHOD_GET_BLOCK_BY_HASH, "hedge_winner"])
            .get(),
        1
    );
    assert_eq!(
        events
            .with_label_values(&["test_chain", METHOD_GET_BLOCK_BY_HASH, "cancellation"])
            .get(),
        1
    );
    assert_eq!(
        durations
            .with_label_values(&["test_chain", METHOD_GET_BLOCK_BY_HASH, "hedge"])
            .get_sample_count(),
        1
    );

    let priorities = provider.take_priorities_snapshot().await;
    assert_eq!(priorities[0].index, 0);
    assert_eq!(priorities[0].last_failed_count, 0);
}

#[tokio::test]
async fn hedging_is_disabled_by_default() {
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(20))),
        EthereumProviderMock::new(None),
    ];
    push_read_response(&providers[0], MockReadResponse::Success(1));
    push_read_response(&providers[1], MockReadResponse::Success(2));
    let fallback = FallbackProviderBuilder::default()
        .add_providers(providers)
        .build();
    let provider = EthereumFallbackProvider::new(fallback, false).with_hedging(None, None);

    assert_eq!(provider.get_block_by_hash_test_call().await.unwrap(), 1);
    assert_eq!(ProviderMock::get_call_counts(&provider).await, vec![1, 0]);
}

#[tokio::test]
async fn primary_within_grace_does_not_start_hedge() {
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(1))),
        EthereumProviderMock::new(None),
    ];
    push_read_response(&providers[0], MockReadResponse::Success(1));
    push_read_response(&providers[1], MockReadResponse::Success(2));
    let fallback = FallbackProviderBuilder::default()
        .add_providers(providers)
        .build();
    let provider = EthereumFallbackProvider::new(fallback, false).with_hedging(
        Some(hedge_config(
            Duration::from_millis(50),
            Duration::from_millis(100),
        )),
        None,
    );

    assert_eq!(provider.get_block_by_hash_test_call().await.unwrap(), 1);
    assert_eq!(ProviderMock::get_call_counts(&provider).await, vec![1, 0]);
}

#[tokio::test]
async fn failed_hedge_advances_while_primary_is_hung() {
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_secs(5))),
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];
    push_read_response(&providers[0], MockReadResponse::Success(1));
    push_read_response(&providers[1], MockReadResponse::RetryableError);
    push_read_response(&providers[2], MockReadResponse::Success(3));
    let fallback = FallbackProviderBuilder::default()
        .add_providers(providers)
        .build();
    let provider = EthereumFallbackProvider::new(fallback, false).with_hedging(
        Some(hedge_config(
            Duration::from_millis(5),
            Duration::from_secs(1),
        )),
        None,
    );

    let result = tokio::time::timeout(
        Duration::from_millis(500),
        provider.get_block_by_hash_test_call(),
    )
    .await
    .expect("failed hedge should advance before the primary timeout")
    .unwrap();
    assert_eq!(result, 3);
    assert_eq!(
        ProviderMock::get_call_counts(&provider).await,
        vec![1, 1, 1]
    );
}

#[tokio::test]
async fn per_attempt_timeout_prevents_all_hung_providers_from_blocking() {
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_secs(5))),
        EthereumProviderMock::new(Some(Duration::from_secs(5))),
    ];
    let fallback = FallbackProviderBuilder::default()
        .add_providers(providers)
        .build();
    let provider = EthereumFallbackProvider::new(fallback, false).with_hedging(
        Some(hedge_config(
            Duration::from_millis(5),
            Duration::from_millis(20),
        )),
        None,
    );

    tokio::time::timeout(
        Duration::from_millis(500),
        provider.get_block_by_hash_test_call(),
    )
    .await
    .expect("per-attempt timeouts should bound all provider attempts")
    .expect_err("all timed-out attempts should fail");
    assert_eq!(ProviderMock::get_call_counts(&provider).await, vec![2, 2]);
}

#[tokio::test]
async fn successful_read_is_not_timed_out_by_stalled_provider_probe() {
    let providers = vec![EthereumProviderMock::new(None)];
    push_read_response(&providers[0], MockReadResponse::Success(1));
    providers[0]
        .responses
        .get_block_number
        .lock()
        .unwrap()
        .push_back(Some(100));
    *providers[0]
        .responses
        .get_block_number_sleep
        .lock()
        .unwrap() = Some(Duration::from_millis(200));
    let fallback = FallbackProviderBuilder::default()
        .add_providers(providers)
        .with_max_block_time(Duration::ZERO)
        .with_call_timeout(Duration::from_millis(100))
        .build();
    let provider = EthereumFallbackProvider::new(fallback, false).with_hedging(
        Some(hedge_config(
            Duration::from_millis(5),
            Duration::from_millis(10),
        )),
        None,
    );

    assert_eq!(
        timeout(
            Duration::from_millis(50),
            provider.get_block_by_hash_test_call()
        )
        .await
        .expect("stalled health probe blocked the completed read")
        .unwrap(),
        1
    );
}

#[tokio::test]
async fn nonretryable_call_remains_sequential_when_hedging_is_enabled() {
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];
    push_read_response(&providers[0], MockReadResponse::NonRetryableError);
    push_read_response(&providers[1], MockReadResponse::Success(2));
    let fallback = FallbackProviderBuilder::default()
        .add_providers(providers)
        .build();
    let provider = EthereumFallbackProvider::new(fallback, false).with_hedging(
        Some(hedge_config(
            Duration::from_millis(50),
            Duration::from_millis(100),
        )),
        None,
    );

    assert!(provider.immutable_call_test_call().await.is_err());
    assert_eq!(ProviderMock::get_call_counts(&provider).await, vec![1, 0]);
}

#[tokio::test]
async fn all_retryable_failures_keep_bounded_retry_behavior() {
    let providers = vec![
        EthereumProviderMock::new(None),
        EthereumProviderMock::new(None),
    ];
    for provider in &providers {
        for _ in 0..2 {
            push_read_response(provider, MockReadResponse::RetryableError);
        }
    }
    let fallback = FallbackProviderBuilder::default()
        .add_providers(providers)
        .build();
    let provider = EthereumFallbackProvider::new(fallback, false).with_hedging(
        Some(hedge_config(
            Duration::from_millis(5),
            Duration::from_millis(100),
        )),
        None,
    );

    assert!(provider.get_block_by_hash_test_call().await.is_err());
    assert_eq!(ProviderMock::get_call_counts(&provider).await, vec![2, 2]);
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

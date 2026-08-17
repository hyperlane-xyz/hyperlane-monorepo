use std::{
    collections::hash_map::DefaultHasher,
    fmt::Debug,
    hash::{Hash, Hasher},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use ethers::providers::{
    JsonRpcClient, ProviderError, Quorum, QuorumError, QuorumProvider, WeightedProvider,
};
use futures_util::{stream::FuturesUnordered, StreamExt};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::time::timeout;

const ETH_GET_BLOCK_BY_NUMBER: &str = "eth_getBlockByNumber";
const LAST_BLOCK_PARAMETER_METHODS: &[&str] = &[
    "eth_call",
    "eth_createAccessList",
    "eth_getStorageAt",
    "eth_getCode",
    "eth_getProof",
    "eth_estimateGas",
    "trace_call",
    "trace_block",
];
const DYNAMIC_BLOCK_TAGS: &[&str] = &["safe", "finalized"];
const MIN_DYNAMIC_TAG_QUORUM_GRACE: Duration = Duration::from_secs(1);
const MAX_ERROR_SUMMARY_CHARS: usize = 240;

/// A quorum transport that pins dynamic finality tags to a concrete height before asking
/// providers to agree on the full RPC response.
///
/// Ethers' [`QuorumProvider`] already does this for `latest`, but sends `safe` and `finalized`
/// directly to every provider. Healthy providers can expose consecutive finalized tips, making
/// exact response quorum impossible even though they agree on the canonical chain. This wrapper
/// first obtains enough successful tag responses to satisfy the configured quorum, waits briefly
/// for timely stragglers, and pins the request to their quorum-th highest height (the highest height
/// known reachable by a quorum). It then delegates the exact-value vote to [`QuorumProvider`].
/// Explicit block numbers, hashes, and `latest` retain ethers' behavior.
///
/// Responses that arrive after the grace period are cancelled. A sufficiently slow honest
/// response can therefore still let a minority low-tip response select an older canonical height;
/// this can delay progress, but cannot forge the result because the pinned request independently
/// requires an exact-value quorum.
#[derive(Clone, Debug)]
pub struct DynamicTagQuorumProvider<C> {
    providers: Vec<C>,
    quorum_provider: QuorumProvider<C>,
    quorum_weight: usize,
}

impl<C: Clone> DynamicTagQuorumProvider<C> {
    /// Creates an equal-weight provider set with the requested quorum rule.
    pub fn new(quorum: Quorum, providers: Vec<C>) -> Self {
        assert!(
            !providers.is_empty(),
            "quorum provider set must not be empty"
        );
        let quorum_provider =
            QuorumProvider::new(quorum, providers.iter().cloned().map(WeightedProvider::new));
        let quorum_weight = quorum_provider.quorum_weight() as usize;
        Self {
            providers,
            quorum_provider,
            quorum_weight,
        }
    }
}

#[derive(Debug, Error)]
enum DynamicTagQuorumError {
    #[error(
        "failed to resolve `{tag}` to a concrete block height: only {successful_responses}/{required_responses} quorum responses succeeded; errors: {errors:?}"
    )]
    InsufficientTagResponses {
        tag: String,
        successful_responses: usize,
        required_responses: usize,
        errors: Vec<String>,
    },

    #[error(
        "no quorum for `{method}` with `{tag}` after pinning block {height}: response summaries: {response_summaries:?}; errors: {errors:?}"
    )]
    PinnedRequestDisagreement {
        method: String,
        tag: String,
        height: u64,
        response_summaries: Vec<String>,
        errors: Vec<String>,
    },
}

impl From<DynamicTagQuorumError> for ProviderError {
    fn from(error: DynamicTagQuorumError) -> Self {
        ProviderError::JsonRpcClientError(Box::new(error))
    }
}

impl<C> DynamicTagQuorumProvider<C>
where
    C: JsonRpcClient + Clone,
    C::Error: Into<ProviderError>,
{
    async fn resolve_dynamic_tag(&self, tag: &str) -> Result<u64, ProviderError> {
        let params = serde_json::json!([tag, false]);
        let mut requests = self
            .providers
            .iter()
            .cloned()
            .map(|provider| {
                let params = params.clone();
                async move {
                    let result: Result<Value, C::Error> =
                        provider.request(ETH_GET_BLOCK_BY_NUMBER, params).await;
                    result.map_err(Into::into)
                }
            })
            .collect::<FuturesUnordered<_>>();

        let mut heights = Vec::with_capacity(self.quorum_weight);
        let mut errors = Vec::new();
        let started_at = Instant::now();

        while let Some(response) = requests.next().await {
            match response.and_then(block_number_from_response) {
                Ok(height) => {
                    heights.push(height);
                    if heights.len() >= self.quorum_weight {
                        break;
                    }
                }
                Err(error) => errors.push(bounded_error_summary(&error)),
            }
        }

        if heights.len() < self.quorum_weight {
            return Err(DynamicTagQuorumError::InsufficientTagResponses {
                tag: tag.to_owned(),
                successful_responses: heights.len(),
                required_responses: self.quorum_weight,
                errors,
            }
            .into());
        }

        // Match ethers' numeric-quorum grace period, with a floor so a fast low-tip response plus
        // one fast honest response cannot exclude a modestly slower honest voter. Once quorum is
        // available, wait at least the floor (or as long as initial quorum took), then cancel.
        let quorum_grace_period = started_at.elapsed().max(MIN_DYNAMIC_TAG_QUORUM_GRACE);
        let _ = timeout(quorum_grace_period, async {
            while let Some(response) = requests.next().await {
                match response.and_then(block_number_from_response) {
                    Ok(height) => heights.push(height),
                    Err(error) => errors.push(bounded_error_summary(&error)),
                }
            }
        })
        .await;

        // The quorum-th highest response is reachable by at least `quorum_weight` providers. A
        // pinned exact-value vote follows, so agreeing on a reachable height cannot mask a fork.
        heights.sort_unstable_by(|a, b| b.cmp(a));
        heights
            .get(self.quorum_weight.saturating_sub(1))
            .copied()
            .ok_or_else(|| {
                ProviderError::CustomError(
                    "dynamic block tag responses unexpectedly disappeared after quorum".into(),
                )
            })
    }

    async fn request_dynamic_tag<R>(
        &self,
        method: &str,
        tag: &str,
        mut params: Value,
        block_parameter_index: usize,
    ) -> Result<R, ProviderError>
    where
        R: DeserializeOwned,
    {
        let height = self.resolve_dynamic_tag(tag).await?;
        let params_array = params.as_array_mut().ok_or_else(|| {
            ProviderError::CustomError("dynamic block tag parameters must be an array".into())
        })?;
        let block_parameter = params_array.get_mut(block_parameter_index).ok_or_else(|| {
            ProviderError::CustomError("dynamic block tag parameter unexpectedly missing".into())
        })?;
        *block_parameter = Value::String(format!("0x{height:x}"));

        self.quorum_provider
            .request(method, params)
            .await
            .map_err(|error| summarize_pinned_quorum_error(method, tag, height, error))
    }
}

#[async_trait]
impl<C> JsonRpcClient for DynamicTagQuorumProvider<C>
where
    C: JsonRpcClient + Clone,
    C::Error: Into<ProviderError>,
{
    type Error = ProviderError;

    async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
    where
        T: Debug + Serialize + Send + Sync,
        R: DeserializeOwned,
    {
        let params = serde_json::to_value(params)?;
        if let Some((tag, block_parameter_index)) = dynamic_block_tag(method, &params) {
            return self
                .request_dynamic_tag(method, &tag, params, block_parameter_index)
                .await;
        }

        match params {
            Value::Null => self.quorum_provider.request(method, ()).await,
            params => self.quorum_provider.request(method, params).await,
        }
    }
}

fn dynamic_block_tag(method: &str, params: &Value) -> Option<(String, usize)> {
    let params = params.as_array()?;
    let block_parameter_index = if method == ETH_GET_BLOCK_BY_NUMBER {
        0
    } else if LAST_BLOCK_PARAMETER_METHODS.contains(&method) {
        params.len().checked_sub(1)?
    } else {
        return None;
    };
    let tag = params.get(block_parameter_index)?.as_str()?;
    DYNAMIC_BLOCK_TAGS
        .contains(&tag)
        .then(|| (tag.to_owned(), block_parameter_index))
}

fn block_number_from_response(response: Value) -> Result<u64, ProviderError> {
    let number = response
        .get("number")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ProviderError::CustomError(
                "dynamic block tag response did not contain a string `number` field".into(),
            )
        })?;
    let number = number.strip_prefix("0x").unwrap_or(number);
    u64::from_str_radix(number, 16).map_err(|error| {
        ProviderError::CustomError(format!(
            "invalid dynamic block tag response number `{number}`: {error}"
        ))
    })
}

fn summarize_pinned_quorum_error(
    method: &str,
    tag: &str,
    height: u64,
    error: ProviderError,
) -> ProviderError {
    let ProviderError::JsonRpcClientError(inner) = error else {
        return error;
    };
    let quorum_error = match inner.downcast::<QuorumError>() {
        Ok(error) => error,
        Err(inner) => return ProviderError::JsonRpcClientError(inner),
    };

    let QuorumError::NoQuorumReached { values, errors } = *quorum_error;
    DynamicTagQuorumError::PinnedRequestDisagreement {
        method: method.to_owned(),
        tag: tag.to_owned(),
        height,
        response_summaries: values.iter().map(summarize_response).collect(),
        errors: errors.iter().map(bounded_error_summary).collect(),
    }
    .into()
}

fn summarize_response(value: &Value) -> String {
    let serialized = serde_json::to_vec(value).unwrap_or_default();
    let mut hasher = DefaultHasher::new();
    serialized.hash(&mut hasher);
    let fingerprint = hasher.finish();
    let number = value.get("number").and_then(Value::as_str).unwrap_or("?");
    let hash = value.get("hash").and_then(Value::as_str).unwrap_or("?");
    format!(
        "number={number}, hash={hash}, bytes={}, fingerprint={fingerprint:016x}",
        serialized.len()
    )
}

fn bounded_error_summary(error: &ProviderError) -> String {
    let summary = error.to_string();
    let mut chars = summary.chars();
    let bounded = chars
        .by_ref()
        .take(MAX_ERROR_SUMMARY_CHARS)
        .collect::<String>();
    if chars.next().is_some() {
        format!("{bounded}...")
    } else {
        bounded
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use ethers::providers::JsonRpcClient;
    use serde::{de::DeserializeOwned, Serialize};
    use tokio::time::{sleep, timeout};

    use super::*;

    #[derive(Clone, Debug)]
    struct MockClient {
        tag_response: Result<Value, String>,
        tag_delay: Duration,
        pinned_responses: Arc<HashMap<String, Result<Value, String>>>,
        calls: Arc<Mutex<Vec<(String, Value)>>>,
    }

    impl MockClient {
        fn new(
            tag_response: Result<Value, String>,
            tag_delay: Duration,
            pinned_responses: HashMap<String, Result<Value, String>>,
        ) -> Self {
            Self {
                tag_response,
                tag_delay,
                pinned_responses: Arc::new(pinned_responses),
                calls: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn calls(&self) -> Vec<(String, Value)> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl JsonRpcClient for MockClient {
        type Error = ProviderError;

        async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
        where
            T: Debug + Serialize + Send + Sync,
            R: DeserializeOwned,
        {
            let params = serde_json::to_value(params)?;
            self.calls
                .lock()
                .unwrap()
                .push((method.to_owned(), params.clone()));

            let response = match method {
                "eth_blockNumber" => self
                    .tag_response
                    .as_ref()
                    .map(|block| block["number"].clone())
                    .map_err(|error| ProviderError::CustomError(error.clone()))?,
                ETH_GET_BLOCK_BY_NUMBER if dynamic_block_tag(method, &params).is_some() => {
                    sleep(self.tag_delay).await;
                    self.tag_response
                        .clone()
                        .map_err(ProviderError::CustomError)?
                }
                ETH_GET_BLOCK_BY_NUMBER | "eth_call" => {
                    let block_parameter_index = if method == ETH_GET_BLOCK_BY_NUMBER {
                        0
                    } else {
                        params.as_array().expect("parameters").len() - 1
                    };
                    let block = params
                        .as_array()
                        .and_then(|params| params.get(block_parameter_index))
                        .expect("block parameter")
                        .to_owned();
                    let block = block
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| block.to_string());
                    self.pinned_responses
                        .get(&block)
                        .unwrap_or_else(|| panic!("missing mock response for {block}"))
                        .clone()
                        .map_err(ProviderError::CustomError)?
                }
                _ => panic!("unexpected method {method}"),
            };

            Ok(serde_json::from_value(response)?)
        }
    }

    fn block(number: u64, hash: &str) -> Value {
        serde_json::json!({
            "number": format!("0x{number:x}"),
            "hash": hash,
            "transactions": [],
        })
    }

    fn client(tag_height: u64, tag_delay: Duration, pinned_height: u64, hash: &str) -> MockClient {
        MockClient::new(
            Ok(block(tag_height, hash)),
            tag_delay,
            HashMap::from([(
                format!("0x{pinned_height:x}"),
                Ok(block(pinned_height, hash)),
            )]),
        )
    }

    #[tokio::test]
    async fn pins_consecutive_safe_and_finalized_tips_to_quorum_reachable_height() {
        for tag in DYNAMIC_BLOCK_TAGS {
            let common_block = block(100, "0xcommon");
            let clients = [
                (100, Duration::ZERO),
                (101, Duration::from_millis(5)),
                (102, Duration::from_secs(30)),
            ]
            .map(|(tip, delay)| {
                MockClient::new(
                    Ok(block(tip, &format!("0xtip{tip}"))),
                    delay,
                    HashMap::from([("0x64".to_owned(), Ok(common_block.clone()))]),
                )
            });
            let provider = DynamicTagQuorumProvider::new(Quorum::Majority, clients.to_vec());

            let response: Value = timeout(
                Duration::from_millis(1_200),
                provider.request(ETH_GET_BLOCK_BY_NUMBER, serde_json::json!([tag, false])),
            )
            .await
            .expect("slow non-quorum provider should be cancelled")
            .unwrap();

            assert_eq!(response, common_block);
            let pinned_requests = clients
                .iter()
                .flat_map(MockClient::calls)
                .filter(|(method, params)| method == ETH_GET_BLOCK_BY_NUMBER && params[0] == "0x64")
                .count();
            assert!(pinned_requests >= 2);
        }
    }

    #[tokio::test]
    async fn timely_honest_quorum_outvotes_fast_byzantine_low_tip() {
        let common_block = block(100, "0xcommon");
        let clients = [
            (0, Duration::ZERO),
            (100, Duration::from_millis(10)),
            (100, Duration::from_millis(250)),
        ]
        .map(|(tip, delay)| {
            MockClient::new(
                Ok(block(tip, &format!("0xtip{tip}"))),
                delay,
                HashMap::from([("0x64".to_owned(), Ok(common_block.clone()))]),
            )
        });
        let provider = DynamicTagQuorumProvider::new(Quorum::Majority, clients.to_vec());

        let response: Value = provider
            .request(
                ETH_GET_BLOCK_BY_NUMBER,
                serde_json::json!(["finalized", false]),
            )
            .await
            .unwrap();

        assert_eq!(response, common_block);
    }

    #[tokio::test]
    async fn keeps_true_pinned_block_disagreement_and_bounds_diagnostics() {
        let large_transactions = vec!["0xdeadbeef"; 2_000];
        let clients = ["0xaaa", "0xbbb", "0xccc"].map(|hash| {
            let mut response = block(100, hash);
            response["transactions"] = serde_json::json!(large_transactions);
            MockClient::new(
                Ok(block(100, hash)),
                Duration::ZERO,
                HashMap::from([("0x64".to_owned(), Ok(response))]),
            )
        });
        let provider = DynamicTagQuorumProvider::new(Quorum::Majority, clients.to_vec());

        let error = provider
            .request::<_, Value>(ETH_GET_BLOCK_BY_NUMBER, serde_json::json!(["safe", false]))
            .await
            .unwrap_err()
            .to_string();

        assert!(error
            .contains("no quorum for `eth_getBlockByNumber` with `safe` after pinning block 100"));
        assert!(error.contains("0xaaa"));
        assert!(error.contains("0xbbb"));
        assert!(error.contains("0xccc"));
        assert!(!error.contains("deadbeef"));
        assert!(error.len() < 1_000, "diagnostic was {} bytes", error.len());
    }

    #[tokio::test]
    async fn leaves_latest_behavior_with_ethers_quorum_provider() {
        let clients = [100, 101, 102].map(|tip| client(tip, Duration::ZERO, 101, "0xcommon"));
        let provider = DynamicTagQuorumProvider::new(Quorum::Majority, clients.to_vec());

        let response: Value = provider
            .request(
                ETH_GET_BLOCK_BY_NUMBER,
                serde_json::json!(["latest", false]),
            )
            .await
            .unwrap();

        assert_eq!(response, block(101, "0xcommon"));
        for client in &clients {
            assert!(client.calls().iter().all(|(_, params)| params.get(0)
                != Some(&Value::String("safe".into()))
                && params.get(0) != Some(&Value::String("finalized".into()))));
        }
    }

    #[tokio::test]
    async fn leaves_explicit_block_number_untouched() {
        let clients = [
            client(100, Duration::ZERO, 42, "0xexplicit"),
            client(101, Duration::ZERO, 42, "0xexplicit"),
            client(102, Duration::ZERO, 42, "0xexplicit"),
        ];
        let provider = DynamicTagQuorumProvider::new(Quorum::Majority, clients.to_vec());

        let response: Value = provider
            .request(ETH_GET_BLOCK_BY_NUMBER, serde_json::json!(["0x2a", false]))
            .await
            .unwrap();

        assert_eq!(response, block(42, "0xexplicit"));
        let calls = clients
            .iter()
            .flat_map(MockClient::calls)
            .collect::<Vec<_>>();
        assert!(calls.len() >= 2);
        assert!(calls.iter().all(|(_, params)| params[0] == "0x2a"));
    }

    #[tokio::test]
    async fn leaves_explicit_block_hash_untouched() {
        let block_hash = serde_json::json!({"blockHash": "0xabc"});
        let block_key = block_hash.to_string();
        let clients = [100, 101, 102].map(|tip| {
            MockClient::new(
                Ok(block(tip, &format!("0xtip{tip}"))),
                Duration::ZERO,
                HashMap::from([(block_key.clone(), Ok(serde_json::json!("0xroot")))]),
            )
        });
        let provider = DynamicTagQuorumProvider::new(Quorum::Majority, clients.to_vec());

        let response: Value = provider
            .request(
                "eth_call",
                serde_json::json!([{"to": "0x1234"}, block_hash.clone()]),
            )
            .await
            .unwrap();

        assert_eq!(response, "0xroot");
        let eth_call_params = clients
            .iter()
            .flat_map(MockClient::calls)
            .filter(|(method, _)| method == "eth_call")
            .map(|(_, params)| params)
            .collect::<Vec<_>>();
        assert!(eth_call_params.len() >= 2);
        assert!(eth_call_params.iter().all(|params| params[1] == block_hash));
    }

    #[tokio::test]
    async fn pins_dynamic_tag_for_eth_call_on_every_provider() {
        let clients = [101, 101, 101].map(|tip| {
            MockClient::new(
                Ok(block(tip, &format!("0xtip{tip}"))),
                Duration::ZERO,
                HashMap::from([("0x65".to_owned(), Ok(serde_json::json!("0xroot")))]),
            )
        });
        let provider = DynamicTagQuorumProvider::new(Quorum::Majority, clients.to_vec());

        let response: Value = provider
            .request(
                "eth_call",
                serde_json::json!([{"to": "0x1234", "data": "0xabcd"}, "finalized"]),
            )
            .await
            .unwrap();

        assert_eq!(response, "0xroot");
        let eth_call_params = clients
            .iter()
            .flat_map(MockClient::calls)
            .filter(|(method, _)| method == "eth_call")
            .map(|(_, params)| params)
            .collect::<Vec<_>>();
        assert!(eth_call_params.len() >= 2);
        assert!(eth_call_params.iter().all(|params| params[1] == "0x65"));
    }

    #[tokio::test]
    async fn fails_retryably_when_dynamic_tag_lacks_quorum_responses() {
        let clients = [
            MockClient::new(Ok(block(100, "0xaaa")), Duration::ZERO, HashMap::new()),
            MockClient::new(
                Err("safe tag unavailable".into()),
                Duration::ZERO,
                HashMap::new(),
            ),
            MockClient::new(
                Err("provider timeout".into()),
                Duration::ZERO,
                HashMap::new(),
            ),
        ];
        let provider = DynamicTagQuorumProvider::new(Quorum::Majority, clients.to_vec());

        let error = provider
            .request::<_, Value>(ETH_GET_BLOCK_BY_NUMBER, serde_json::json!(["safe", false]))
            .await
            .unwrap_err()
            .to_string();

        assert!(error.contains("only 1/2 quorum responses succeeded"));
        assert!(error.contains("safe tag unavailable"));
        assert!(error.contains("provider timeout"));
    }
}

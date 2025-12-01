use std::collections::VecDeque;
use std::fmt::Debug;
use std::ops::Deref;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ethers::providers::{HttpClientError, JsonRpcClient};
use ethers::types::TransactionReceipt;
use ethers_prometheus::json_rpc_client::{JsonRpcBlockGetter, BLOCK_NUMBER_RPC};
use hyperlane_core::rpc_clients::test::ProviderMock;
use hyperlane_metric::prometheus_metric::PrometheusConfigExt;
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::time::sleep;

use crate::rpc_clients::fallback::{METHOD_GET_TRANSACTION_RECEIPT, METHOD_SEND_RAW_TRANSACTION};

type ResponseList<T> = Arc<Mutex<VecDeque<T>>>;

#[derive(Clone, Debug, Default)]
pub struct EthereumProviderMockResponses {
    pub get_block_number: ResponseList<Option<u64>>,
    pub get_tx_receipt: ResponseList<Option<TransactionReceipt>>,
    pub send_raw_transaction: ResponseList<Option<u64>>,
}

#[derive(Clone, Debug)]
pub struct EthereumProviderMock {
    pub provider: ProviderMock,
    pub responses: EthereumProviderMockResponses,
}

impl Deref for EthereumProviderMock {
    type Target = ProviderMock;

    fn deref(&self) -> &Self::Target {
        &self.provider
    }
}

impl EthereumProviderMock {
    pub fn new(request_sleep: Option<Duration>) -> Self {
        Self {
            provider: ProviderMock::new(request_sleep),
            responses: EthereumProviderMockResponses::default(),
        }
    }
}

impl From<EthereumProviderMock> for JsonRpcBlockGetter<EthereumProviderMock> {
    fn from(val: EthereumProviderMock) -> Self {
        JsonRpcBlockGetter::new(val)
    }
}

fn dummy_error_return_value<R: DeserializeOwned>() -> Result<R, HttpClientError> {
    serde_json::from_str("not-a-json").map_err(|e| HttpClientError::SerdeJson {
        err: e,
        text: "".to_owned(),
    })
}

#[async_trait::async_trait]
impl JsonRpcClient for EthereumProviderMock {
    type Error = HttpClientError;

    /// Pushes the `(method, params)` to the back of the `requests` queue,
    /// pops the responses from the back of the `responses` queue
    async fn request<T: Debug + Serialize + Send + Sync, R: DeserializeOwned>(
        &self,
        method: &str,
        params: T,
    ) -> Result<R, Self::Error> {
        self.push(method, params);
        if let Some(sleep_duration) = self.provider.request_sleep() {
            sleep(sleep_duration).await;
        }
        tracing::debug!("Called {method}");
        if method == BLOCK_NUMBER_RPC {
            let resp = match self.responses.get_block_number.lock().unwrap().pop_front() {
                Some(s) => s,
                None => return dummy_error_return_value(),
            };
            return serde_json::from_str(&serde_json::to_string(&resp).unwrap()).map_err(|e| {
                HttpClientError::SerdeJson {
                    err: e,
                    text: "".to_owned(),
                }
            });
        }
        if method == METHOD_GET_TRANSACTION_RECEIPT {
            let resp = match self.responses.get_tx_receipt.lock().unwrap().pop_front() {
                Some(s) => s,
                None => return dummy_error_return_value(),
            };
            return serde_json::from_str(&serde_json::to_string(&resp).unwrap()).map_err(|e| {
                HttpClientError::SerdeJson {
                    err: e,
                    text: "".to_owned(),
                }
            });
        }
        if method == METHOD_SEND_RAW_TRANSACTION {
            let resp = match self
                .responses
                .send_raw_transaction
                .lock()
                .unwrap()
                .pop_front()
            {
                Some(s) => s,
                None => return dummy_error_return_value(),
            };
            return serde_json::from_str(&serde_json::to_string(&resp).unwrap()).map_err(|e| {
                HttpClientError::SerdeJson {
                    err: e,
                    text: "".to_owned(),
                }
            });
        }
        dummy_error_return_value()
    }
}

impl PrometheusConfigExt for EthereumProviderMock {
    fn node_host(&self) -> &str {
        "test_provider_host"
    }

    fn chain_name(&self) -> &str {
        todo!()
    }
}

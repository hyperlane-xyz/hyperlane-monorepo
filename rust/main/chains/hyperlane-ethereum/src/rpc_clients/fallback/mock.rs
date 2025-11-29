use std::fmt::Debug;
use std::ops::Deref;
use std::time::Duration;

use ethers::providers::{HttpClientError, JsonRpcClient};
use ethers::types::TransactionReceipt;
use ethers_prometheus::json_rpc_client::JsonRpcBlockGetter;
use hyperlane_core::rpc_clients::test::ProviderMock;
use hyperlane_metric::prometheus_metric::PrometheusConfigExt;
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::time::sleep;

use crate::rpc_clients::fallback::METHOD_GET_TRANSACTION_RECEIPT;

#[derive(Debug, Clone)]
pub struct EthereumProviderMock {
    provider: ProviderMock,
    block_number: Option<u64>,
    pub tx_receipt: Option<TransactionReceipt>,
}

impl Deref for EthereumProviderMock {
    type Target = ProviderMock;

    fn deref(&self) -> &Self::Target {
        &self.provider
    }
}

impl EthereumProviderMock {
    pub fn new(request_sleep: Option<Duration>, block_number: Option<u64>) -> Self {
        Self {
            provider: ProviderMock::new(request_sleep),
            block_number,
            tx_receipt: None,
        }
    }
}

impl From<EthereumProviderMock> for JsonRpcBlockGetter<EthereumProviderMock> {
    fn from(val: EthereumProviderMock) -> Self {
        JsonRpcBlockGetter::new(val)
    }
}

fn dummy_success_return_value<R: DeserializeOwned>(
    block_number: u64,
) -> Result<R, HttpClientError> {
    serde_json::from_str(&block_number.to_string()).map_err(|e| HttpClientError::SerdeJson {
        err: e,
        text: "".to_owned(),
    })
}

fn dummy_error_return_value<R: DeserializeOwned>() -> Result<R, HttpClientError> {
    serde_json::from_str("not-a-json").map_err(|e| HttpClientError::SerdeJson {
        err: e,
        text: "".to_owned(),
    })
}

fn get_tx_receipt<R: DeserializeOwned>(
    tx_receipt: &Option<TransactionReceipt>,
) -> Result<R, HttpClientError> {
    serde_json::from_str(&serde_json::to_string(tx_receipt).unwrap()).map_err(|e| {
        HttpClientError::SerdeJson {
            err: e,
            text: "".to_owned(),
        }
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
        if method == METHOD_GET_TRANSACTION_RECEIPT {
            return get_tx_receipt(&self.tx_receipt);
        }
        if self.block_number.is_none() {
            dummy_error_return_value()
        } else {
            dummy_success_return_value(self.block_number.unwrap())
        }
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

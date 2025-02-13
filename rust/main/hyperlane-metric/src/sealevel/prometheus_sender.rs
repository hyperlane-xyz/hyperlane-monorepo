use std::{
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};

use maplit::hashmap;
use reqwest::{
    header::{CONTENT_TYPE, RETRY_AFTER},
    StatusCode,
};
use solana_client::{
    client_error::ClientError,
    rpc_request::{RpcError, RpcRequest},
    rpc_sender::{RpcSender, RpcTransportStats},
};
use tokio::time::sleep;
use url::Url;

use crate::prometheus_metric::{
    JsonRpcClientMetrics, PrometheusJsonRpcClientConfig, PrometheusJsonRpcClientConfigExt,
};
use crate::sealevel::http_sender::{rpc_error_object_to_response, HttpSender, RpcErrorObject};

/// Sealevel RPC with prometheus metrics
pub struct PrometheusSealevelRpcSender {
    pub inner: HttpSender,
    pub metrics: JsonRpcClientMetrics,
    pub config: PrometheusJsonRpcClientConfig,
}

impl PrometheusSealevelRpcSender {
    pub fn new(
        url: Url,
        metrics: JsonRpcClientMetrics,
        config: PrometheusJsonRpcClientConfig,
    ) -> Self {
        Self {
            inner: HttpSender::new(url),
            metrics,
            config,
        }
    }
}

/// Implement this trait so it can be used with Solana RPC Client
#[async_trait::async_trait]
impl RpcSender for PrometheusSealevelRpcSender {
    fn get_transport_stats(&self) -> RpcTransportStats {
        self.inner.stats.read().unwrap().clone()
    }

    async fn send(
        &self,
        request: RpcRequest,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, ClientError> {
        let start = Instant::now();
        let request_id = self.inner.request_id.fetch_add(1, Ordering::Relaxed);
        let method = format!("{}", request);
        let res =
            send_sealevel_rpc_request(&self.inner.client, self.url(), request_id, request, params)
                .await;

        let labels = hashmap! {
            "provider_node" => self.config.node_host(),
            "chain" => self.config.chain_name(),
            "method" => &method,
            "status" => if res.is_ok() { "success" } else { "failure" }
        };
        if let Some(counter) = &self.metrics.request_count {
            counter.with(&labels).inc()
        }
        if let Some(counter) = &self.metrics.request_duration_seconds {
            counter
                .with(&labels)
                .inc_by((Instant::now() - start).as_secs_f64())
        };
        res
    }
    fn url(&self) -> String {
        self.inner.url.clone()
    }
}

/// Most of this code is taken from solana-client HttpSender
/// code base, because HttpSender is private.
/// https://github.com/anza-xyz/agave/blob/master/rpc-client/src/http_sender.rs#L137
async fn send_sealevel_rpc_request(
    client: &Arc<reqwest::Client>,
    url: String,
    request_id: u64,
    request: RpcRequest,
    params: serde_json::Value,
) -> Result<serde_json::Value, ClientError> {
    let request_json = {
        let jsonrpc = "2.0";
        serde_json::json!({
            "jsonrpc": jsonrpc,
            "id": request_id,
            "method": format!("{}", request),
            "params": params,
        })
        .to_string()
    };

    let mut too_many_requests_retries = 5;

    loop {
        let response = {
            let request_json = request_json.clone();
            client
                .post(&url)
                .header(CONTENT_TYPE, "application/json")
                .body(request_json)
                .send()
                .await
        }?;

        if !response.status().is_success() {
            if response.status() == StatusCode::TOO_MANY_REQUESTS && too_many_requests_retries > 0 {
                let mut duration = Duration::from_millis(500);
                if let Some(retry_after) = response.headers().get(RETRY_AFTER) {
                    if let Ok(retry_after) = retry_after.to_str() {
                        if let Ok(retry_after) = retry_after.parse::<u64>() {
                            if retry_after < 120 {
                                duration = Duration::from_secs(retry_after);
                            }
                        }
                    }
                }

                too_many_requests_retries -= 1;
                sleep(duration).await;
                continue;
            }
            return Err(response.error_for_status().unwrap_err().into());
        }

        let mut json = response.json::<serde_json::Value>().await?;
        if json["error"].is_object() {
            return match serde_json::from_value::<RpcErrorObject>(json["error"].clone()) {
                Ok(rpc_error_object) => {
                    let data = rpc_error_object_to_response(&json, &rpc_error_object);
                    Err(RpcError::RpcResponseError {
                        code: rpc_error_object.code,
                        message: rpc_error_object.message,
                        data,
                    }
                    .into())
                }
                Err(err) => Err(RpcError::RpcRequestError(format!(
                    "Failed to deserialize RPC error response: {} [{}]",
                    serde_json::to_string(&json["error"]).unwrap(),
                    err
                ))
                .into()),
            };
        }
        return Ok(json["result"].take());
    }
}

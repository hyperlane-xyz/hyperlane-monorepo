use std::{
    sync::{atomic::AtomicU64, Arc, RwLock},
    time::Duration,
};

use serde::Deserialize;
use solana_client::{
    rpc_custom_error, rpc_request::RpcResponseErrorData,
    rpc_response::RpcSimulateTransactionResult, rpc_sender::RpcTransportStats,
};
use tracing::debug;

#[derive(Clone, Debug, Deserialize)]
pub struct RpcErrorObject {
    pub code: i64,
    pub message: String,
}

pub struct HttpSender {
    pub client: Arc<reqwest::Client>,
    pub url: String,
    pub request_id: AtomicU64,
    pub stats: RwLock<RpcTransportStats>,
}

/// Nonblocking [`RpcSender`] over HTTP.
impl HttpSender {
    /// Create an HTTP RPC sender.
    ///
    /// The URL is an HTTP URL, usually for port 8899, as in
    /// "http://localhost:8899". The sender has a default timeout of 30 seconds.
    pub fn new<U: ToString>(url: U) -> Self {
        Self::new_with_timeout(url, Duration::from_secs(30))
    }

    /// Create an HTTP RPC sender.
    ///
    /// The URL is an HTTP URL, usually for port 8899.
    pub fn new_with_timeout<U: ToString>(url: U, timeout: Duration) -> Self {
        let client = Arc::new(
            reqwest::Client::builder()
                .timeout(timeout)
                .pool_idle_timeout(timeout)
                .build()
                .expect("build rpc client"),
        );

        Self {
            client,
            url: url.to_string(),
            request_id: AtomicU64::new(0),
            stats: RwLock::new(RpcTransportStats::default()),
        }
    }
}

pub fn rpc_error_object_to_response(
    json: &serde_json::Value,
    rpc_error_object: &RpcErrorObject,
) -> RpcResponseErrorData {
    match rpc_error_object.code {
        rpc_custom_error::JSON_RPC_SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE => {
            match serde_json::from_value::<RpcSimulateTransactionResult>(
                json["error"]["data"].clone(),
            ) {
                Ok(data) => RpcResponseErrorData::SendTransactionPreflightFailure(data),
                Err(err) => {
                    debug!(
                        "Failed to deserialize RpcSimulateTransactionResult: {:?}",
                        err
                    );
                    RpcResponseErrorData::Empty
                }
            }
        }
        rpc_custom_error::JSON_RPC_SERVER_ERROR_NODE_UNHEALTHY => {
            match serde_json::from_value::<rpc_custom_error::NodeUnhealthyErrorData>(
                json["error"]["data"].clone(),
            ) {
                Ok(rpc_custom_error::NodeUnhealthyErrorData { num_slots_behind }) => {
                    RpcResponseErrorData::NodeUnhealthy { num_slots_behind }
                }
                Err(_err) => RpcResponseErrorData::Empty,
            }
        }
        _ => RpcResponseErrorData::Empty,
    }
}

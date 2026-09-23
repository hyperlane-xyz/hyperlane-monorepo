use std::{
    fmt::Debug,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use ethers::providers::{HttpClientError, JsonRpcClient};
use reqwest::{Client, StatusCode, Url};
use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;

#[derive(Deserialize)]
struct Response<'a> {
    jsonrpc: &'a str,
    #[serde(rename = "id")]
    _id: u64,
    #[serde(borrow, default, deserialize_with = "present_raw_value")]
    result: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present_raw_value")]
    error: Option<&'a RawValue>,
}

// A present null result is a successful response, distinct from a missing field.
fn present_raw_value<'de, D>(deserializer: D) -> Result<Option<&'de RawValue>, D::Error>
where
    D: Deserializer<'de>,
{
    <&RawValue>::deserialize(deserializer).map(Some)
}

/// HTTP JSON-RPC transport that preserves status-only rate limit responses.
/// The pinned ethers transport discards HTTP status before decoding the body.
#[derive(Clone, Debug)]
pub(crate) struct StatusAwareHttp {
    client: Client,
    url: Url,
    next_id: Arc<AtomicU64>,
}

impl StatusAwareHttp {
    pub(crate) fn new(url: Url, client: Client) -> Self {
        Self {
            client,
            url,
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl JsonRpcClient for StatusAwareHttp {
    type Error = HttpClientError;

    async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
    where
        T: Debug + Serialize + Send + Sync,
        R: DeserializeOwned,
    {
        let mut payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": self.next_id.fetch_add(1, Ordering::Relaxed),
            "method": method,
        });
        // Match ethers' omission of params for zero-sized arguments such as ().
        if std::mem::size_of::<T>() != 0 {
            payload["params"] =
                serde_json::to_value(params).map_err(|err| HttpClientError::SerdeJson {
                    err,
                    text: String::new(),
                })?;
        }
        let response = self
            .client
            .post(self.url.clone())
            .json(&payload)
            .send()
            .await?;
        // Check before reading the body: a 429 body may be empty, non-JSON, or stalled.
        // Other statuses still decode JSON-RPC errors, preserving revert data.
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            response.error_for_status_ref()?;
        }
        let body = response.bytes().await?;
        let decode_error = |err| HttpClientError::SerdeJson {
            err,
            text: String::from_utf8_lossy(&body).into_owned(),
        };
        let response: Response<'_> = serde_json::from_slice(&body).map_err(decode_error)?;
        if response.jsonrpc != "2.0" {
            return Err(decode_error(serde::de::Error::custom(
                "invalid JSON-RPC response",
            )));
        }
        if let Some(error) = response.error {
            return Err(HttpClientError::JsonRpcError(
                serde_json::from_str(error.get()).map_err(decode_error)?,
            ));
        }
        let result = response
            .result
            .ok_or_else(|| decode_error(serde::de::Error::custom("missing JSON-RPC result")))?;
        serde_json::from_str(result.get()).map_err(decode_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc_clients::rate_limit::is_rate_limited;
    use serde_json::Value;
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
    };

    async fn request_response<R: DeserializeOwned>(
        status: &str,
        body: &str,
    ) -> Result<R, HttpClientError> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let url = format!(
            "http://{}",
            listener.local_addr().expect("listener address")
        );
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.expect("accept request");
            let mut socket = BufReader::new(socket);
            let mut content_length = 0;
            loop {
                let mut line = String::new();
                assert!(socket.read_line(&mut line).await.expect("request header") > 0);
                if line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        content_length = value.trim().parse::<usize>().expect("request length");
                    }
                }
            }
            let mut body = vec![0; content_length];
            socket.read_exact(&mut body).await.expect("request body");
            socket
                .get_mut()
                .write_all(response.as_bytes())
                .await
                .expect("send response");
        });
        let client = StatusAwareHttp::new(url.parse().expect("test URL"), Client::new());
        let result = client.request::<_, R>("eth_call", ()).await;
        server.await.expect("test server");
        result
    }

    #[tokio::test]
    async fn http_429_is_recognized_even_without_a_quota_message() {
        for body in [
            "",
            "busy",
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"busy"}}"#,
        ] {
            let error = request_response::<Value>("429 Too Many Requests", body)
                .await
                .unwrap_err();
            assert!(is_rate_limited(&error));
        }
    }

    #[tokio::test]
    async fn rpc_error_details_are_preserved_without_endpoint_cooldown() {
        for status in ["200 OK", "500 Internal Server Error"] {
            let error = request_response::<Value>(status,
                r#"{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted: rate limit exceeded","data":"0x1234"}}"#
            ).await.unwrap_err();
            assert!(!is_rate_limited(&error));
            let HttpClientError::JsonRpcError(error) = error else {
                panic!("expected JSON-RPC error")
            };
            assert_eq!(error.code, 3);
            assert_eq!(error.data, Some(serde_json::json!("0x1234")));
        }
    }

    #[tokio::test]
    async fn successful_results_include_null() {
        for result in [Value::Null, serde_json::json!("0x1234")] {
            let body = serde_json::json!({"jsonrpc": "2.0", "id": 1, "result": result});
            assert_eq!(
                request_response::<Value>("200 OK", &body.to_string())
                    .await
                    .unwrap(),
                result
            );
        }
    }
    #[tokio::test]
    async fn decodes_typed_logs_and_optional_null_results() {
        let logs: Vec<ethers::types::Log> = request_response(
            "200 OK",
            r#"{"jsonrpc":"2.0","id":1,"result":[{"address":"0x0000000000000000000000000000000000000001","topics":[],"data":"0x0102"}]}"#,
        ).await.unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].data.as_ref(), &[1, 2]);
        let result: Option<String> =
            request_response("200 OK", r#"{"jsonrpc":"2.0","id":1,"result":null}"#)
                .await
                .unwrap();
        assert_eq!(result, None);
        assert!(
            request_response::<Option<String>>("200 OK", r#"{"jsonrpc":"2.0","id":1}"#,)
                .await
                .is_err()
        );
    }
}

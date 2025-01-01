use std::io;

use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::RELAYER_METRICS_PORT;

/// Copied from agents/relayer/src/server/message_retry.rs
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct MessageRetryResponse {
    /// ID of the retry request
    pub uuid: String,
    /// how many pending operations were evaluated
    pub evaluated: usize,
    /// how many of the pending operations matched the retry request pattern
    pub matched: u64,
}

pub fn run_retry_request() -> io::Result<MessageRetryResponse> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();

    let res = runtime
        .unwrap()
        .block_on(async { call_retry_request().await });
    res
}

async fn call_retry_request() -> io::Result<MessageRetryResponse> {
    let client = reqwest::Client::new();

    let url = Url::parse(&format!(
        "http://0.0.0.0:{RELAYER_METRICS_PORT}/message_retry"
    ))
    .map_err(|err| {
        eprintln!("Failed to parse url: {err}");
        io::Error::new(io::ErrorKind::InvalidInput, err.to_string())
    })?;

    let body = vec![serde_json::json!({
        "message_id": "*"
    })];
    let retry_response = client.post(url).json(&body).send().await.map_err(|err| {
        eprintln!("Failed to send request: {err}");
        io::Error::new(io::ErrorKind::InvalidData, err.to_string())
    })?;

    let response_text = retry_response.text().await.map_err(|err| {
        eprintln!("Failed to parse response body: {err}");
        io::Error::new(io::ErrorKind::InvalidData, err.to_string())
    })?;

    println!("Retry Request Response: {:?}", response_text);

    let response_json: MessageRetryResponse =
        serde_json::from_str(&response_text).map_err(|err| {
            eprintln!("Failed to parse response body to json: {err}");
            io::Error::new(io::ErrorKind::InvalidData, err.to_string())
        })?;

    Ok(response_json)
}

use std::{io, time::Duration};

use maplit::hashmap;
use reqwest::Url;

use relayer::server::MessageRetryResponse;

use crate::{fetch_metric, RELAYER_METRICS_PORT};

/// create tokio runtime to send a retry request to
/// relayer to retry all existing messages in the queues
pub fn run_retry_request() -> io::Result<MessageRetryResponse> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
    runtime
        .unwrap()
        .block_on(async { call_retry_request().await })
}

/// sends a request to relayer to retry all existing messages
/// in the queues
async fn call_retry_request() -> io::Result<MessageRetryResponse> {
    let client = reqwest::Client::new();

    let url = Url::parse(&format!(
        "http://0.0.0.0:{RELAYER_METRICS_PORT}/message_retry"
    ))
    .map_err(|err| {
        println!("Failed to parse url: {err}");
        io::Error::new(io::ErrorKind::InvalidInput, err.to_string())
    })?;

    let body = vec![serde_json::json!({
        "message_id": "*"
    })];
    let retry_response = client
        .post(url)
        .json(&body)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|err| {
            println!("Failed to send request: {err}");
            io::Error::new(io::ErrorKind::InvalidData, err.to_string())
        })?;

    let response_text = retry_response.text().await.map_err(|err| {
        println!("Failed to parse response body: {err}");
        io::Error::new(io::ErrorKind::InvalidData, err.to_string())
    })?;

    println!("Retry Request Response: {:?}", response_text);

    let response_json: MessageRetryResponse =
        serde_json::from_str(&response_text).map_err(|err| {
            println!("Failed to parse response body to json: {err}");
            io::Error::new(io::ErrorKind::InvalidData, err.to_string())
        })?;

    Ok(response_json)
}

pub fn fetch_relayer_message_processed_count() -> eyre::Result<u32> {
    Ok(fetch_metric(
        RELAYER_METRICS_PORT,
        "hyperlane_messages_processed_count",
        &hashmap! {},
    )?
    .iter()
    .sum::<u32>())
}

pub fn fetch_relayer_gas_payment_event_count() -> eyre::Result<u32> {
    Ok(fetch_metric(
        RELAYER_METRICS_PORT,
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "gas_payments"},
    )?
    .iter()
    .sum::<u32>())
}

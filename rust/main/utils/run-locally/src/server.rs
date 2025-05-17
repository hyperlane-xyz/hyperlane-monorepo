use std::{io, time::Duration};

use hyperlane_core::H256;
use maplit::hashmap;
use reqwest::Url;

use relayer::server::{insert_messages, message_retry::MessageRetryResponse};

use crate::{fetch_metric, RELAYER_METRICS_PORT};

/// create tokio runtime to send a retry request to
/// relayer to retry all existing messages in the queues
pub fn send_retry_request() -> io::Result<MessageRetryResponse> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
    runtime
        .unwrap()
        .block_on(async { send_retry_request_non_blocking().await })
}

/// sends a request to relayer to retry all existing messages
/// in the queues
async fn send_retry_request_non_blocking() -> io::Result<MessageRetryResponse> {
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

pub fn send_insert_message_request() -> io::Result<insert_messages::ResponseBody> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
    runtime
        .unwrap()
        .block_on(async { send_insert_message_request_non_blocking().await })
}

async fn send_insert_message_request_non_blocking() -> io::Result<insert_messages::ResponseBody> {
    let client = reqwest::Client::new();
    let url =
        Url::parse(&format!("http://0.0.0.0:{RELAYER_METRICS_PORT}/messages")).map_err(|err| {
            println!("Failed to parse url: {err}");
            io::Error::new(io::ErrorKind::InvalidInput, err.to_string())
        })?;

    let body = insert_messages::RequestBody {
        messages: vec![
            insert_messages::Message {
                version: 0,
                nonce: 10000,
                origin: 9913371,
                destination: 9913372,
                sender: H256::from_low_u64_be(1000),
                recipient: H256::from_low_u64_be(2000),
                body: Vec::new(),
                dispatched_block_number: 10000,
            },
            insert_messages::Message {
                version: 0,
                nonce: 10001,
                origin: 9913371,
                destination: 9913372,
                sender: H256::from_low_u64_be(1000),
                recipient: H256::from_low_u64_be(2000),
                body: Vec::new(),
                dispatched_block_number: 10001,
            },
        ],
    };

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

    let response_json = serde_json::from_str(&response_text).map_err(|err| {
        println!("Failed to parse response body to json: {err}");
        io::Error::new(io::ErrorKind::InvalidData, err.to_string())
    })?;

    Ok(response_json)
}

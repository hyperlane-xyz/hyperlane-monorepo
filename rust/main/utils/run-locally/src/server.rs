use std::io;

use reqwest::Url;

use crate::RELAYER_METRICS_PORT;

pub fn run_retry_request() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();

    let _ = runtime
        .unwrap()
        .block_on(async { call_retry_request().await });
}

async fn call_retry_request() -> io::Result<()> {
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

    let response_json = retry_response.text().await.map_err(|err| {
        eprintln!("Failed to parse response body: {err}");
        io::Error::new(io::ErrorKind::InvalidData, err.to_string())
    })?;

    eprintln!("Retry Request Response: {:?}", response_json);

    Ok(())
}

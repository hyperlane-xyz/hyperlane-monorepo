use eyre::eyre;
use reqwest::Response;
use serde::de::DeserializeOwned;

const RELAY_URL: &str = "https://relay.gelato.digital";

pub mod sponsored_call;
pub mod task_status;
pub mod types;

async fn parse_response<T: DeserializeOwned>(resp: Response) -> eyre::Result<T> {
    let resp_bytes = resp.bytes().await?;
    match serde_json::from_slice(&resp_bytes) {
        Ok(v) => Ok(v),
        Err(e) => {
            let text =
                String::from_utf8(resp_bytes.into()).unwrap_or_else(|_| "<NOT TEXT>".to_owned());
            Err(eyre!("{}; {}", e, text))
        }
    }
}

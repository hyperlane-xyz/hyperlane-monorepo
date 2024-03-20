use axum::{extract::State, routing, Router};
use derive_new::new;
use hyperlane_core::H256;
use reqwest::StatusCode;
use std::str::FromStr;
use tokio::sync::broadcast::Sender;

const MESSAGE_RETRY_API_BASE: &str = "/message_retry";
pub const ENDPOINT_MESSAGES_QUEUE_SIZE: usize = 1_000;

/// Returns a vector of validator-specific endpoint routes to be served.
/// Can be extended with additional routes and feature flags to enable/disable individually.
pub fn routes(tx: Sender<H256>) -> Vec<(&'static str, Router)> {
    let message_retry_api = MessageRetryApi::new(tx);

    vec![message_retry_api.get_route()]
}

#[derive(new, Clone)]
pub struct MessageRetryApi {
    tx: Sender<H256>,
}

async fn retry_message(
    State(tx): State<Sender<H256>>,
    message_id: String,
) -> Result<(), StatusCode> {
    let message_id = H256::from_str(&message_id).map_err(|_| StatusCode::BAD_REQUEST)?;
    let _ = tx
        .send(message_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(())
}

impl MessageRetryApi {
    pub fn router(&self) -> Router {
        Router::new()
            .route("/:message_id", routing::get(retry_message))
            .with_state(self.tx.clone())
    }

    pub fn get_route(&self) -> (&'static str, Router) {
        (MESSAGE_RETRY_API_BASE, self.router())
    }
}

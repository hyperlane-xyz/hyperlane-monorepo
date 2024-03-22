use axum::{
    extract::{Query, State},
    routing, Router,
};
use derive_new::new;
use hyperlane_core::H256;
use reqwest::StatusCode;
use serde::Deserialize;
use std::str::FromStr;
use tokio::sync::broadcast::Sender;

use crate::msg::pending_operation::PendingOperation;

const MESSAGE_RETRY_API_BASE: &str = "/message_retry";
pub const ENDPOINT_MESSAGES_QUEUE_SIZE: usize = 1_000;

/// Returns a vector of validator-specific endpoint routes to be served.
/// Can be extended with additional routes and feature flags to enable/disable individually.
pub fn routes(tx: Sender<MessageRetryRequest>) -> Vec<(&'static str, Router)> {
    let message_retry_api = MessageRetryApi::new(tx);

    vec![message_retry_api.get_route()]
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MessageRetryRequest {
    MessageId(H256),
    DestinationDomain(u32),
}

impl PartialEq<Box<dyn PendingOperation>> for &MessageRetryRequest {
    fn eq(&self, other: &Box<dyn PendingOperation>) -> bool {
        match self {
            MessageRetryRequest::MessageId(message_id) => message_id == &other.id(),
            MessageRetryRequest::DestinationDomain(destination_domain) => {
                destination_domain == &other.destination_domain().id()
            }
        }
    }
}

#[derive(new, Clone)]
pub struct MessageRetryApi {
    tx: Sender<MessageRetryRequest>,
}

#[derive(Deserialize)]
struct RawMessageRetryRequest {
    message_id: Option<String>,
    destination_domain: Option<u32>,
}

impl From<RawMessageRetryRequest> for Vec<MessageRetryRequest> {
    fn from(request: RawMessageRetryRequest) -> Self {
        let mut retry_requests = Vec::new();
        if let Some(message_id) = request.message_id {
            if let Ok(message_id) = H256::from_str(&message_id) {
                retry_requests.push(MessageRetryRequest::MessageId(message_id));
            }
        }
        if let Some(destination_domain) = request.destination_domain {
            retry_requests.push(MessageRetryRequest::DestinationDomain(destination_domain));
        }
        retry_requests
    }
}

async fn retry_message(
    State(tx): State<Sender<MessageRetryRequest>>,
    Query(request): Query<RawMessageRetryRequest>,
) -> Result<String, StatusCode> {
    let retry_requests: Vec<MessageRetryRequest> = request.into();
    if retry_requests.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    retry_requests
        .into_iter()
        .map(|req| tx.send(req))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    Ok("Moved message(s) to the front of the queue".to_string())
}

impl MessageRetryApi {
    pub fn router(&self) -> Router {
        Router::new()
            .route("/", routing::get(retry_message))
            .with_state(self.tx.clone())
    }

    pub fn get_route(&self) -> (&'static str, Router) {
        (MESSAGE_RETRY_API_BASE, self.router())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use ethers::utils::hex::ToHex;
    use hyperlane_core::{MpmcChannel, MpmcReceiver};
    use std::net::SocketAddr;

    fn setup_test_server() -> (SocketAddr, MpmcReceiver<MessageRetryRequest>) {
        let mpmc_channel = MpmcChannel::<MessageRetryRequest>::new(ENDPOINT_MESSAGES_QUEUE_SIZE);
        let message_retry_api = MessageRetryApi::new(mpmc_channel.sender());
        let (path, retry_router) = message_retry_api.get_route();
        let app = Router::new().nest(path, retry_router);

        // Running the app in the background using a test server
        let server =
            axum::Server::bind(&"127.0.0.1:0".parse().unwrap()).serve(app.into_make_service());
        let addr = server.local_addr();
        tokio::spawn(server);

        (addr, mpmc_channel.receiver())
    }

    #[tokio::test]
    async fn test_message_id_retry() {
        let (addr, mut rx) = setup_test_server();

        // Create a random message ID
        let message_id = H256::random();

        // Send a GET request to the server
        let response = reqwest::get(format!(
            "http://{}{}?message_id={}",
            addr,
            MESSAGE_RETRY_API_BASE,
            message_id.encode_hex::<String>()
        ))
        .await
        .unwrap();

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        assert_eq!(
            rx.receiver.try_recv().unwrap(),
            MessageRetryRequest::MessageId(message_id)
        );
    }

    #[tokio::test]
    async fn test_destination_domain_retry() {
        let (addr, mut rx) = setup_test_server();

        // Create a random destination domain
        let destination_domain = 42;

        // Send a GET request to the server
        let response = reqwest::get(format!(
            "http://{}{}?destination_domain={}",
            addr, MESSAGE_RETRY_API_BASE, destination_domain
        ))
        .await
        .unwrap();

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        assert_eq!(
            rx.receiver.try_recv().unwrap(),
            MessageRetryRequest::DestinationDomain(destination_domain)
        );
    }
}

use axum::{
    extract::{Query, State},
    routing, Router,
};
use derive_new::new;
use hyperlane_core::{ChainCommunicationError, QueueOperation, H256};
use serde::Deserialize;
use std::str::FromStr;
use tokio::sync::broadcast::Sender;

const MESSAGE_RETRY_API_BASE: &str = "/message_retry";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MessageRetryRequest {
    MessageId(H256),
    DestinationDomain(u32),
}

impl PartialEq<QueueOperation> for &MessageRetryRequest {
    fn eq(&self, other: &QueueOperation) -> bool {
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

impl TryFrom<RawMessageRetryRequest> for Vec<MessageRetryRequest> {
    type Error = ChainCommunicationError;

    fn try_from(request: RawMessageRetryRequest) -> Result<Self, Self::Error> {
        let mut retry_requests = Vec::new();
        if let Some(message_id) = request.message_id {
            retry_requests.push(MessageRetryRequest::MessageId(H256::from_str(&message_id)?));
        }
        if let Some(destination_domain) = request.destination_domain {
            retry_requests.push(MessageRetryRequest::DestinationDomain(destination_domain));
        }
        Ok(retry_requests)
    }
}

async fn retry_message(
    State(tx): State<Sender<MessageRetryRequest>>,
    Query(request): Query<RawMessageRetryRequest>,
) -> String {
    let retry_requests: Vec<MessageRetryRequest> = match request.try_into() {
        Ok(retry_requests) => retry_requests,
        // Technically it's bad practice to print the error message to the user, but
        // this endpoint is for debugging purposes only.
        Err(err) => {
            return format!("Failed to parse retry request: {}", err);
        }
    };

    if retry_requests.is_empty() {
        return "No retry requests found. Please provide either a message_id or destination_domain.".to_string();
    }

    if let Err(err) = retry_requests
        .into_iter()
        .map(|req| tx.send(req))
        .collect::<Result<Vec<_>, _>>()
    {
        return format!("Failed to send retry request to the queue: {}", err);
    }

    "Moved message(s) to the front of the queue".to_string()
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
    use crate::server::ENDPOINT_MESSAGES_QUEUE_SIZE;

    use super::*;
    use axum::http::StatusCode;
    use ethers::utils::hex::ToHex;
    use std::net::SocketAddr;
    use tokio::sync::broadcast::{Receiver, Sender};

    fn setup_test_server() -> (SocketAddr, Receiver<MessageRetryRequest>) {
        let broadcast_tx = Sender::<MessageRetryRequest>::new(ENDPOINT_MESSAGES_QUEUE_SIZE);
        let message_retry_api = MessageRetryApi::new(broadcast_tx.clone());
        let (path, retry_router) = message_retry_api.get_route();
        let app = Router::new().nest(path, retry_router);

        // Running the app in the background using a test server
        let server =
            axum::Server::bind(&"127.0.0.1:0".parse().unwrap()).serve(app.into_make_service());
        let addr = server.local_addr();
        tokio::spawn(server);

        (addr, broadcast_tx.subscribe())
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
            rx.try_recv().unwrap(),
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
            rx.try_recv().unwrap(),
            MessageRetryRequest::DestinationDomain(destination_domain)
        );
    }
}

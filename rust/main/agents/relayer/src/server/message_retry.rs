use crate::settings::matching_list::MatchingList;
use axum::{extract::State, routing, Json, Router};
use derive_new::new;
use tokio::sync::broadcast::Sender;

const MESSAGE_RETRY_API_BASE: &str = "/message_retry";

#[derive(new, Clone)]
pub struct MessageRetryApi {
    tx: Sender<MatchingList>,
}

async fn retry_message(
    State(tx): State<Sender<MatchingList>>,
    Json(retry_req_payload): Json<MatchingList>,
) -> String {
    match tx.send(retry_req_payload) {
        Ok(_) => "Moved message(s) to the front of the queue".to_string(),
        // Technically it's bad practice to print the error message to the user, but
        // this endpoint is for debugging purposes only.
        Err(err) => format!("Failed to send retry request to the queue: {}", err),
    }
}

impl MessageRetryApi {
    pub fn router(&self) -> Router {
        Router::new()
            .route("/", routing::post(retry_message))
            .with_state(self.tx.clone())
    }

    pub fn get_route(&self) -> (&'static str, Router) {
        (MESSAGE_RETRY_API_BASE, self.router())
    }
}

#[cfg(test)]
mod tests {
    use crate::{msg::op_queue::test::MockPendingOperation, server::ENDPOINT_MESSAGES_QUEUE_SIZE};

    use super::*;
    use axum::http::StatusCode;
    use hyperlane_core::{HyperlaneMessage, QueueOperation};
    use serde_json::json;
    use std::net::SocketAddr;
    use tokio::sync::broadcast::{Receiver, Sender};

    fn setup_test_server() -> (SocketAddr, Receiver<MatchingList>) {
        let broadcast_tx = Sender::<MatchingList>::new(ENDPOINT_MESSAGES_QUEUE_SIZE);
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

        let client = reqwest::Client::new();
        // Create a random message with a random message ID
        let message = HyperlaneMessage::default();
        let pending_operation = MockPendingOperation::with_message_data(message.clone());
        let matching_list_body = json!([
            {
                "messageid": message.id()
            }
        ]);

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send()
            .await
            .unwrap();

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let list = rx.try_recv().unwrap();
        // Check that the list received by the server matches the pending operation
        assert!(list.op_matches(&(Box::new(pending_operation) as QueueOperation)));
    }

    #[tokio::test]
    async fn test_destination_domain_retry() {
        let (addr, mut rx) = setup_test_server();

        let client = reqwest::Client::new();
        let message = HyperlaneMessage {
            // Use a random destination domain
            destination: 42,
            ..Default::default()
        };
        let pending_operation = MockPendingOperation::with_message_data(message.clone());
        let matching_list_body = json!([
            {
                "destinationdomain": message.destination
            }
        ]);

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send()
            .await
            .unwrap();

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let list = rx.try_recv().unwrap();
        // Check that the list received by the server matches the pending operation
        assert!(list.op_matches(&(Box::new(pending_operation) as QueueOperation)));
    }

    #[tokio::test]
    async fn test_origin_domain_retry() {
        let (addr, mut rx) = setup_test_server();

        let client = reqwest::Client::new();
        let message = HyperlaneMessage {
            // Use a random origin domain
            origin: 42,
            ..Default::default()
        };
        let pending_operation = MockPendingOperation::with_message_data(message.clone());
        let matching_list_body = json!([
            {
                "origindomain": message.origin
            }
        ]);

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send()
            .await
            .unwrap();

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let list = rx.try_recv().unwrap();
        // Check that the list received by the server matches the pending operation
        assert!(list.op_matches(&(Box::new(pending_operation) as QueueOperation)));
    }

    #[tokio::test]
    async fn test_sender_address_retry() {
        let (addr, mut rx) = setup_test_server();

        let client = reqwest::Client::new();
        let message = HyperlaneMessage::default();
        let pending_operation = MockPendingOperation::with_message_data(message.clone());
        let matching_list_body = json!([
            {
                "senderaddress": message.sender
            }
        ]);

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send()
            .await
            .unwrap();

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let list = rx.try_recv().unwrap();
        // Check that the list received by the server matches the pending operation
        assert!(list.op_matches(&(Box::new(pending_operation) as QueueOperation)));
    }

    #[tokio::test]
    async fn test_recipient_address_retry() {
        let (addr, mut rx) = setup_test_server();

        let client = reqwest::Client::new();
        let message = HyperlaneMessage::default();
        let pending_operation = MockPendingOperation::with_message_data(message.clone());
        let matching_list_body = json!([
            {
                "recipientaddress": message.recipient
            }
        ]);

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send()
            .await
            .unwrap();

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let list = rx.try_recv().unwrap();
        // Check that the list received by the server matches the pending operation
        assert!(list.op_matches(&(Box::new(pending_operation) as QueueOperation)));
    }

    #[tokio::test]
    async fn test_multiple_retry() {
        let (addr, mut rx) = setup_test_server();

        let client = reqwest::Client::new();
        let message = HyperlaneMessage {
            // Use a random origin domain
            origin: 42,
            ..Default::default()
        };
        let pending_operation = MockPendingOperation::with_message_data(message.clone());
        let matching_list_body = json!([
            {
                "origindomain": message.origin
            },
            {
                "destinationdomain": message.destination
            },
            {
                "messageid": message.id()
            }
        ]);

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send()
            .await
            .unwrap();

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let list = rx.try_recv().unwrap();
        // Check that the list received by the server matches the pending operation
        assert!(list.op_matches(&(Box::new(pending_operation) as QueueOperation)));
    }
}

use std::sync::Arc;

use crate::settings::matching_list::MatchingList;

use axum::{extract::State, routing, Json, Router};

use derive_new::new;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast::Sender, mpsc, Mutex};

const MESSAGE_RETRY_API_BASE: &str = "/message_retry";

#[derive(new)]
pub struct MessageRetryApi {
    tx: Sender<MessageRetryRequest>,
    rx: Arc<Mutex<mpsc::Receiver<MessageRetryResponse>>>,
}

#[derive(Clone, Debug)]
pub struct MessageRetryApiState {
    pub tx: Sender<MessageRetryRequest>,
    pub rx: Arc<Mutex<mpsc::Receiver<MessageRetryResponse>>>,
}

#[derive(Clone, Debug)]
pub struct MessageRetryRequest {
    pub uuid: String,
    pub pattern: MatchingList,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MessageRetryResponse {
    /// ID of the retry request
    pub uuid: String,
    /// how many pending operations were processed
    pub processed: usize,
    /// how many of the pending operations matched the retry request pattern
    pub matched: u64,
}

async fn retry_message(
    State(state): State<MessageRetryApiState>,
    Json(retry_req_payload): Json<MatchingList>,
) -> Result<Json<MessageRetryResponse>, String> {
    let uuid = uuid::Uuid::new_v4();
    let uuid_string = uuid.to_string();

    tracing::debug!("Sending message retry request: {uuid_string}");

    state
        .tx
        .send(MessageRetryRequest {
            uuid: uuid_string.clone(),
            pattern: retry_req_payload,
        })
        .map_err(|err| {
            // Technically it's bad practice to print the error message to the user, but
            // this endpoint is for debugging purposes only.
            format!("Failed to send retry request to the queue: {}", err)
        })?;

    let mut rx = state.rx.lock().await;

    // Wait for response from message retry.
    // Warning: this potentially blocks other retry requests
    // from properly returning because their response might be consumed by
    // another request
    loop {
        tracing::debug!("Waiting for response from relayer: {uuid_string}");
        if let Some(resp) = rx.recv().await {
            tracing::debug!("Relayer response: {}", resp.uuid);
            if resp.uuid == uuid_string {
                return Ok(Json(resp));
            }
        }
    }
}

impl MessageRetryApi {
    pub fn router(&self) -> Router {
        Router::new()
            .route("/", routing::post(retry_message))
            .with_state(MessageRetryApiState {
                tx: self.tx.clone(),
                rx: self.rx.clone(),
            })
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
    use tokio::sync::{
        broadcast::{Receiver, Sender},
        mpsc,
    };

    #[derive(Debug)]
    struct TestServerSetup {
        pub socket_address: SocketAddr,
        pub retry_req_rx: Receiver<MessageRetryRequest>,
        pub retry_resp_tx: mpsc::Sender<MessageRetryResponse>,
    }

    fn setup_test_server() -> TestServerSetup {
        let broadcast_tx = Sender::new(ENDPOINT_MESSAGES_QUEUE_SIZE);
        let (retry_response_tx, retry_response_rx) = mpsc::channel(ENDPOINT_MESSAGES_QUEUE_SIZE);

        let message_retry_api = MessageRetryApi::new(
            broadcast_tx.clone(),
            Arc::new(Mutex::new(retry_response_rx)),
        );
        let (path, retry_router) = message_retry_api.get_route();

        let app = Router::new().nest(path, retry_router);

        // Running the app in the background using a test server
        let server =
            axum::Server::bind(&"127.0.0.1:0".parse().unwrap()).serve(app.into_make_service());
        let addr = server.local_addr();
        tokio::spawn(server);

        let retry_req_rx = broadcast_tx.subscribe();

        TestServerSetup {
            socket_address: addr,
            retry_req_rx,
            retry_resp_tx: retry_response_tx,
        }
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_message_id_retry() {
        let TestServerSetup {
            socket_address: addr,
            mut retry_req_rx,
            retry_resp_tx,
            ..
        } = setup_test_server();

        let client = reqwest::Client::new();
        // Create a random message with a random message ID
        let message = HyperlaneMessage::default();
        let pending_operation = MockPendingOperation::with_message_data(message.clone());
        let matching_list_body = json!([
            {
                "messageid": message.id()
            }
        ]);

        // spawn a task to respond to message retry request
        let task = async move {
            if let Ok(req) = retry_req_rx.recv().await {
                // Check that the list received by the server matches the pending operation
                assert!(req
                    .pattern
                    .op_matches(&(Box::new(pending_operation.clone()) as QueueOperation)));
                let resp = MessageRetryResponse {
                    uuid: req.uuid,
                    processed: 0,
                    matched: 0,
                };
                retry_resp_tx.send(resp).await.unwrap();
            }
        };

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send();

        let (_t1, response_res) = tokio::join!(task, response);

        let response = response_res.unwrap();
        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_body = response
            .text()
            .await
            .expect("Failed to parse response body");

        let resp_json: MessageRetryResponse =
            serde_json::from_str(&resp_body).expect("Failed to deserialize response body");
        assert_eq!(resp_json.processed, 0);
        assert_eq!(resp_json.matched, 0);
    }

    #[tokio::test]
    async fn test_destination_domain_retry() {
        let TestServerSetup {
            socket_address: addr,
            mut retry_req_rx,
            retry_resp_tx,
            ..
        } = setup_test_server();

        let client = reqwest::Client::new();
        let mut message = HyperlaneMessage::default();
        // Use a random destination domain
        message.destination = 42;
        let pending_operation = MockPendingOperation::with_message_data(message.clone());
        let matching_list_body = json!([
            {
                "destinationdomain": message.destination
            }
        ]);

        // spawn a task to respond to message retry request
        let task = async move {
            if let Ok(req) = retry_req_rx.recv().await {
                // Check that the list received by the server matches the pending operation
                assert!(req
                    .pattern
                    .op_matches(&(Box::new(pending_operation.clone()) as QueueOperation)));
                let resp = MessageRetryResponse {
                    uuid: req.uuid,
                    processed: 10,
                    matched: 2,
                };
                retry_resp_tx.send(resp).await.unwrap();
            }
        };

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send();

        let (_t1, response_res) = tokio::join!(task, response);

        let response = response_res.unwrap();
        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_body = response
            .text()
            .await
            .expect("Failed to parse response body");

        let resp_json: MessageRetryResponse =
            serde_json::from_str(&resp_body).expect("Failed to deserialize response body");
        assert_eq!(resp_json.processed, 10);
        assert_eq!(resp_json.matched, 2);
    }

    #[tokio::test]
    async fn test_origin_domain_retry() {
        let TestServerSetup {
            socket_address: addr,
            mut retry_req_rx,
            retry_resp_tx,
            ..
        } = setup_test_server();

        let client = reqwest::Client::new();
        let mut message = HyperlaneMessage::default();
        // Use a random origin domain
        message.origin = 42;
        let pending_operation = MockPendingOperation::with_message_data(message.clone());
        let matching_list_body = json!([
            {
                "origindomain": message.origin
            }
        ]);

        // spawn a task to respond to message retry request
        let task = async move {
            if let Ok(req) = retry_req_rx.recv().await {
                // Check that the list received by the server matches the pending operation
                assert!(req
                    .pattern
                    .op_matches(&(Box::new(pending_operation.clone()) as QueueOperation)));
                let resp = MessageRetryResponse {
                    uuid: req.uuid,
                    processed: 10,
                    matched: 2,
                };
                retry_resp_tx.send(resp).await.unwrap();
            }
        };

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send();

        let (_t1, response_res) = tokio::join!(task, response);

        let response = response_res.unwrap();
        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_body = response
            .text()
            .await
            .expect("Failed to parse response body");

        let resp_json: MessageRetryResponse =
            serde_json::from_str(&resp_body).expect("Failed to deserialize response body");
        assert_eq!(resp_json.processed, 10);
        assert_eq!(resp_json.matched, 2);
    }

    #[tokio::test]
    async fn test_sender_address_retry() {
        let TestServerSetup {
            socket_address: addr,
            mut retry_req_rx,
            retry_resp_tx,
            ..
        } = setup_test_server();

        let client = reqwest::Client::new();
        let message = HyperlaneMessage::default();
        let pending_operation = MockPendingOperation::with_message_data(message.clone());
        let matching_list_body = json!([
            {
                "senderaddress": message.sender
            }
        ]);

        // spawn a task to respond to message retry request
        let task = async move {
            if let Ok(req) = retry_req_rx.recv().await {
                // Check that the list received by the server matches the pending operation
                assert!(req
                    .pattern
                    .op_matches(&(Box::new(pending_operation.clone()) as QueueOperation)));
                let resp = MessageRetryResponse {
                    uuid: req.uuid,
                    processed: 10,
                    matched: 2,
                };
                retry_resp_tx.send(resp).await.unwrap();
            }
        };

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send();

        let (_t1, response_res) = tokio::join!(task, response);

        let response = response_res.unwrap();
        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_body = response
            .text()
            .await
            .expect("Failed to parse response body");

        let resp_json: MessageRetryResponse =
            serde_json::from_str(&resp_body).expect("Failed to deserialize response body");
        assert_eq!(resp_json.processed, 10);
        assert_eq!(resp_json.matched, 2);
    }

    #[tokio::test]
    async fn test_recipient_address_retry() {
        let TestServerSetup {
            socket_address: addr,
            mut retry_req_rx,
            retry_resp_tx,
            ..
        } = setup_test_server();

        let client = reqwest::Client::new();
        let message = HyperlaneMessage::default();
        let pending_operation = MockPendingOperation::with_message_data(message.clone());
        let matching_list_body = json!([
            {
                "recipientaddress": message.recipient
            }
        ]);

        // spawn a task to respond to message retry request
        let task = async move {
            if let Ok(req) = retry_req_rx.recv().await {
                // Check that the list received by the server matches the pending operation
                assert!(req
                    .pattern
                    .op_matches(&(Box::new(pending_operation.clone()) as QueueOperation)));
                let resp = MessageRetryResponse {
                    uuid: req.uuid,
                    processed: 10,
                    matched: 2,
                };
                retry_resp_tx.send(resp).await.unwrap();
            }
        };

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send();

        let (_t1, response_res) = tokio::join!(task, response);

        let response = response_res.unwrap();
        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_body = response
            .text()
            .await
            .expect("Failed to parse response body");

        let resp_json: MessageRetryResponse =
            serde_json::from_str(&resp_body).expect("Failed to deserialize response body");
        assert_eq!(resp_json.processed, 10);
        assert_eq!(resp_json.matched, 2);
    }

    #[tokio::test]
    async fn test_multiple_retry() {
        let TestServerSetup {
            socket_address: addr,
            mut retry_req_rx,
            retry_resp_tx,
            ..
        } = setup_test_server();

        let client = reqwest::Client::new();
        let mut message = HyperlaneMessage::default();
        // Use a random origin domain
        message.origin = 42;
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

        // spawn a task to respond to message retry request
        let task = async move {
            if let Ok(req) = retry_req_rx.recv().await {
                // Check that the list received by the server matches the pending operation
                assert!(req
                    .pattern
                    .op_matches(&(Box::new(pending_operation.clone()) as QueueOperation)));
                let resp = MessageRetryResponse {
                    uuid: req.uuid,
                    processed: 10,
                    matched: 2,
                };
                retry_resp_tx.send(resp).await.unwrap();
            }
        };

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send();

        let (_t1, response_res) = tokio::join!(task, response);

        let response = response_res.unwrap();
        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_body = response
            .text()
            .await
            .expect("Failed to parse response body");

        let resp_json: MessageRetryResponse =
            serde_json::from_str(&resp_body).expect("Failed to deserialize response body");
        assert_eq!(resp_json.processed, 10);
        assert_eq!(resp_json.matched, 2);
    }
}

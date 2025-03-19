use crate::{msg::op_submitter::SUBMITTER_QUEUE_COUNT, settings::matching_list::MatchingList};
use axum::{extract::State, routing, Json, Router};
use derive_new::new;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast::Sender, mpsc};

const MESSAGE_RETRY_API_BASE: &str = "/message_retry";

#[derive(Clone, Debug, new)]
pub struct MessageRetryApi {
    retry_request_transmitter: Sender<MessageRetryRequest>,
    destination_chains: usize,
}

#[derive(Clone, Debug)]
pub struct MessageRetryRequest {
    pub uuid: String,
    pub pattern: MatchingList,
    pub transmitter: mpsc::Sender<MessageRetryQueueResponse>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, new)]
pub struct MessageRetryQueueResponse {
    /// how many pending operations were evaluated
    pub evaluated: usize,
    /// how many of the pending operations matched the retry request pattern
    pub matched: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct MessageRetryResponse {
    /// ID of the retry request
    pub uuid: String,
    /// how many pending operations were evaluated
    pub evaluated: usize,
    /// how many of the pending operations matched the retry request pattern
    pub matched: u64,
}

async fn retry_message(
    State(state): State<MessageRetryApi>,
    Json(retry_req_payload): Json<MatchingList>,
) -> Result<Json<MessageRetryResponse>, String> {
    let uuid = uuid::Uuid::new_v4();
    let uuid_string = uuid.to_string();

    tracing::debug!(?retry_req_payload);
    tracing::debug!(uuid = uuid_string, "Sending message retry request");

    // Create a channel that can hold each chain's SerialSubmitter
    // message retry responses.
    // 3 queues for each chain (prepare, submit, confirm)
    let (transmitter, mut receiver) =
        mpsc::channel(SUBMITTER_QUEUE_COUNT * state.destination_chains);
    state
        .retry_request_transmitter
        .send(MessageRetryRequest {
            uuid: uuid_string.clone(),
            pattern: retry_req_payload,
            transmitter,
        })
        .map_err(|err| {
            // Technically it's bad practice to print the error message to the user, but
            // this endpoint is for debugging purposes only.
            format!("Failed to send retry request to the queue: {}", err)
        })?;

    let mut resp = MessageRetryResponse {
        uuid: uuid_string,
        evaluated: 0,
        matched: 0,
    };

    // Wait for responses from relayer
    tracing::debug!(uuid = resp.uuid, "Waiting for response from relayer");
    while let Some(relayer_resp) = receiver.recv().await {
        tracing::debug!(
            evaluated = relayer_resp.evaluated,
            matched = relayer_resp.matched,
            "Received relayer response"
        );
        resp.evaluated += relayer_resp.evaluated;
        resp.matched += relayer_resp.matched;
    }

    Ok(Json(resp))
}

impl MessageRetryApi {
    pub fn router(&self) -> Router {
        Router::new()
            .route("/", routing::post(retry_message))
            .with_state(self.clone())
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
    use serde::de::DeserializeOwned;
    use serde_json::json;
    use std::net::SocketAddr;
    use tokio::sync::broadcast::{Receiver, Sender};

    #[derive(Debug)]
    struct TestServerSetup {
        pub socket_address: SocketAddr,
        pub retry_req_rx: Receiver<MessageRetryRequest>,
    }

    fn setup_test_server() -> TestServerSetup {
        let broadcast_tx = Sender::new(ENDPOINT_MESSAGES_QUEUE_SIZE);

        let message_retry_api = MessageRetryApi::new(broadcast_tx.clone(), 10);
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
        }
    }

    async fn send_retry_responses_future(
        mut retry_request_receiver: Receiver<MessageRetryRequest>,
        pending_operations: Vec<QueueOperation>,
        metrics: Vec<(usize, u64)>,
    ) {
        if let Ok(req) = retry_request_receiver.recv().await {
            for (op, (evaluated, matched)) in pending_operations.iter().zip(metrics) {
                // Check that the list received by the server matches the pending operation
                assert!(req.pattern.op_matches(op));
                let resp = MessageRetryQueueResponse { evaluated, matched };
                req.transmitter.send(resp).await.unwrap();
            }
        }
    }

    async fn parse_response_to_json<T: DeserializeOwned>(response: reqwest::Response) -> T {
        let resp_body = response
            .text()
            .await
            .expect("Failed to parse response body");
        let resp_json: T =
            serde_json::from_str(&resp_body).expect("Failed to deserialize response body");
        resp_json
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_message_id_retry() {
        let TestServerSetup {
            socket_address: addr,
            retry_req_rx,
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
        let respond_task = send_retry_responses_future(
            retry_req_rx,
            vec![Box::new(pending_operation.clone()) as QueueOperation],
            vec![(1, 1)],
        );

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send();

        let (_t1, response_res) = tokio::join!(respond_task, response);

        let response = response_res.unwrap();
        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_json: MessageRetryResponse = parse_response_to_json(response).await;
        assert_eq!(resp_json.evaluated, 1);
        assert_eq!(resp_json.matched, 1);
    }

    #[tokio::test]
    async fn test_destination_domain_retry() {
        let TestServerSetup {
            socket_address: addr,
            retry_req_rx,
            ..
        } = setup_test_server();

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

        // spawn a task to respond to message retry request
        let respond_task = send_retry_responses_future(
            retry_req_rx,
            vec![Box::new(pending_operation.clone()) as QueueOperation],
            vec![(1, 1)],
        );

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send();

        let (_t1, response_res) = tokio::join!(respond_task, response);

        let response = response_res.unwrap();
        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_json: MessageRetryResponse = parse_response_to_json(response).await;
        assert_eq!(resp_json.evaluated, 1);
        assert_eq!(resp_json.matched, 1);
    }

    #[tokio::test]
    async fn test_origin_domain_retry() {
        let TestServerSetup {
            socket_address: addr,
            retry_req_rx,
            ..
        } = setup_test_server();

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

        // spawn a task to respond to message retry request
        let respond_task = send_retry_responses_future(
            retry_req_rx,
            vec![Box::new(pending_operation.clone()) as QueueOperation],
            vec![(1, 1)],
        );

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send();

        let (_t1, response_res) = tokio::join!(respond_task, response);

        let response = response_res.unwrap();

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_json: MessageRetryResponse = parse_response_to_json(response).await;
        assert_eq!(resp_json.evaluated, 1);
        assert_eq!(resp_json.matched, 1);
    }

    #[tokio::test]
    async fn test_sender_address_retry() {
        let TestServerSetup {
            socket_address: addr,
            retry_req_rx,
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
        let respond_task = send_retry_responses_future(
            retry_req_rx,
            vec![Box::new(pending_operation.clone()) as QueueOperation],
            vec![(1, 1)],
        );

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send();

        let (_t1, response_res) = tokio::join!(respond_task, response);

        let response = response_res.unwrap();
        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_json: MessageRetryResponse = parse_response_to_json(response).await;
        assert_eq!(resp_json.evaluated, 1);
        assert_eq!(resp_json.matched, 1);
    }

    #[tokio::test]
    async fn test_recipient_address_retry() {
        let TestServerSetup {
            socket_address: addr,
            retry_req_rx,
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
        let respond_task = send_retry_responses_future(
            retry_req_rx,
            vec![Box::new(pending_operation.clone()) as QueueOperation],
            vec![(1, 1)],
        );

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send();

        let (_t1, response_res) = tokio::join!(respond_task, response);

        let response = response_res.unwrap();
        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_json: MessageRetryResponse = parse_response_to_json(response).await;
        assert_eq!(resp_json.evaluated, 1);
        assert_eq!(resp_json.matched, 1);
    }

    #[tokio::test]
    async fn test_multiple_retry() {
        let TestServerSetup {
            socket_address: addr,
            retry_req_rx,
            ..
        } = setup_test_server();

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

        // spawn a task to respond to message retry request
        let respond_task = send_retry_responses_future(
            retry_req_rx,
            vec![Box::new(pending_operation.clone()) as QueueOperation],
            vec![(1, 1)],
        );

        // Send a POST request to the server
        let response = client
            .post(format!("http://{}{}", addr, MESSAGE_RETRY_API_BASE))
            .json(&matching_list_body) // Set the request body
            .send();

        let (_t1, response_res) = tokio::join!(respond_task, response);

        let response = response_res.unwrap();
        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_json: MessageRetryResponse = parse_response_to_json(response).await;
        assert_eq!(resp_json.evaluated, 1);
        assert_eq!(resp_json.matched, 1);
    }
}

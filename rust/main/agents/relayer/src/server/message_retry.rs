use crate::{msg::op_submitter::SUBMITTER_QUEUE_COUNT, settings::matching_list::MatchingList};
use axum::{extract::State, routing, Json, Router};
use derive_new::new;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast::Sender, mpsc};

const MESSAGE_RETRY_API_BASE: &str = "/message_retry";

#[derive(Clone, Debug, new)]
pub struct ServerState {
    retry_request_transmitter: Sender<MessageRetryRequest>,
    destination_chains: usize,
}
impl ServerState {
    pub fn router(self) -> Router {
        Router::new()
            .route(MESSAGE_RETRY_API_BASE, routing::post(handler))
            .with_state(self)
    }
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

async fn handler(
    State(state): State<ServerState>,
    Json(payload): Json<MatchingList>,
) -> Result<Json<MessageRetryResponse>, String> {
    let uuid = uuid::Uuid::new_v4();
    let uuid_string = uuid.to_string();

    tracing::debug!(?payload);
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
            pattern: payload,
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

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{header::CONTENT_TYPE, Method, Request, Response, StatusCode},
    };
    use hyperlane_core::{HyperlaneMessage, QueueOperation};
    use serde_json::json;
    use tokio::sync::broadcast::{Receiver, Sender};
    use tower::ServiceExt;

    use crate::{
        msg::op_queue::test::MockPendingOperation, server::ENDPOINT_MESSAGES_QUEUE_SIZE,
        test_utils::request::parse_body_to_json,
    };

    use super::*;

    #[derive(Debug)]
    struct TestServerSetup {
        pub app: Router,
        pub retry_req_rx: Receiver<MessageRetryRequest>,
    }

    fn setup_test_server() -> TestServerSetup {
        let broadcast_tx = Sender::new(ENDPOINT_MESSAGES_QUEUE_SIZE);

        let message_retry_api = ServerState::new(broadcast_tx.clone(), 10);
        let retry_req_rx = broadcast_tx.subscribe();

        let app = message_retry_api.router();

        TestServerSetup { app, retry_req_rx }
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

    async fn send_retry_request(app: Router, body: &serde_json::Value) -> Response<Body> {
        let api_url = MESSAGE_RETRY_API_BASE;
        let request = Request::builder()
            .uri(api_url)
            .method(Method::POST)
            .header(CONTENT_TYPE, "application/json")
            .body(serde_json::to_string(body).expect("Failed to serialize body"))
            .expect("Failed to build request");
        let response = app.oneshot(request).await.expect("Failed to send request");
        response
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_message_id_retry() {
        let TestServerSetup { app, retry_req_rx } = setup_test_server();

        // Create a random message with a random message ID
        let message = HyperlaneMessage::default();
        let pending_operation = MockPendingOperation::with_message_data(message.clone());

        // spawn a task to respond to message retry request
        let respond_task = send_retry_responses_future(
            retry_req_rx,
            vec![Box::new(pending_operation.clone()) as QueueOperation],
            vec![(1, 1)],
        );
        tokio::task::spawn(async { respond_task.await });

        let body = json!([
            {
                "messageid": message.id()
            }
        ]);

        // Send a POST request to the server
        let response = send_retry_request(app, &body).await;

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_json: MessageRetryResponse = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_json.evaluated, 1);
        assert_eq!(resp_json.matched, 1);
    }

    #[tokio::test]
    async fn test_destination_domain_retry() {
        let TestServerSetup { app, retry_req_rx } = setup_test_server();

        let message = HyperlaneMessage {
            // Use a random destination domain
            destination: 42,
            ..Default::default()
        };
        let pending_operation = MockPendingOperation::with_message_data(message.clone());

        // spawn a task to respond to message retry request
        let respond_task = send_retry_responses_future(
            retry_req_rx,
            vec![Box::new(pending_operation.clone()) as QueueOperation],
            vec![(1, 1)],
        );
        tokio::task::spawn(async { respond_task.await });

        let body = json!([
            {
                "destinationdomain": message.destination
            }
        ]);

        // Send a POST request to the server
        let response = send_retry_request(app, &body).await;

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_json: MessageRetryResponse = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_json.evaluated, 1);
        assert_eq!(resp_json.matched, 1);
    }

    #[tokio::test]
    async fn test_origin_domain_retry() {
        let TestServerSetup { app, retry_req_rx } = setup_test_server();

        let message = HyperlaneMessage {
            // Use a random origin domain
            origin: 42,
            ..Default::default()
        };
        let pending_operation = MockPendingOperation::with_message_data(message.clone());

        // spawn a task to respond to message retry request
        let respond_task = send_retry_responses_future(
            retry_req_rx,
            vec![Box::new(pending_operation.clone()) as QueueOperation],
            vec![(1, 1)],
        );
        tokio::task::spawn(async { respond_task.await });

        let body = json!([
            {
                "origindomain": message.origin
            }
        ]);

        // Send a POST request to the server
        let response = send_retry_request(app, &body).await;

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_json: MessageRetryResponse = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_json.evaluated, 1);
        assert_eq!(resp_json.matched, 1);
    }

    #[tokio::test]
    async fn test_sender_address_retry() {
        let TestServerSetup { app, retry_req_rx } = setup_test_server();

        let message = HyperlaneMessage::default();
        let pending_operation = MockPendingOperation::with_message_data(message.clone());

        // spawn a task to respond to message retry request
        let respond_task = send_retry_responses_future(
            retry_req_rx,
            vec![Box::new(pending_operation.clone()) as QueueOperation],
            vec![(1, 1)],
        );
        tokio::task::spawn(async { respond_task.await });

        let body = json!([
            {
                "senderaddress": message.sender
            }
        ]);

        // Send a POST request to the server
        let response = send_retry_request(app, &body).await;

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_json: MessageRetryResponse = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_json.evaluated, 1);
        assert_eq!(resp_json.matched, 1);
    }

    #[tokio::test]
    async fn test_recipient_address_retry() {
        let TestServerSetup { app, retry_req_rx } = setup_test_server();

        let message = HyperlaneMessage::default();
        let pending_operation = MockPendingOperation::with_message_data(message.clone());

        // spawn a task to respond to message retry request
        let respond_task = send_retry_responses_future(
            retry_req_rx,
            vec![Box::new(pending_operation.clone()) as QueueOperation],
            vec![(1, 1)],
        );
        tokio::task::spawn(async { respond_task.await });

        let body = json!([
            {
                "recipientaddress": message.recipient
            }
        ]);

        // Send a POST request to the server
        let response = send_retry_request(app, &body).await;

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_json: MessageRetryResponse = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_json.evaluated, 1);
        assert_eq!(resp_json.matched, 1);
    }

    #[tokio::test]
    async fn test_multiple_retry() {
        let TestServerSetup { app, retry_req_rx } = setup_test_server();

        let message = HyperlaneMessage {
            // Use a random origin domain
            origin: 42,
            ..Default::default()
        };
        let pending_operation = MockPendingOperation::with_message_data(message.clone());

        // spawn a task to respond to message retry request
        let respond_task = send_retry_responses_future(
            retry_req_rx,
            vec![Box::new(pending_operation.clone()) as QueueOperation],
            vec![(1, 1)],
        );
        tokio::task::spawn(async { respond_task.await });

        let body = json!([
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
        let response = send_retry_request(app, &body).await;

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);

        let resp_json: MessageRetryResponse = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_json.evaluated, 1);
        assert_eq!(resp_json.matched, 1);
    }
}

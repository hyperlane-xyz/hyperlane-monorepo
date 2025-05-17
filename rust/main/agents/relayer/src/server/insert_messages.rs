use std::collections::HashMap;

use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use derive_new::new;
use hyperlane_base::db::{HyperlaneDb, HyperlaneRocksDB};
use hyperlane_core::{HyperlaneMessage, H256};
use serde::{Deserialize, Serialize};

use crate::server::utils::ServerErrorResponse;

use super::utils::{ServerResult, ServerSuccessResponse};

#[derive(Clone, Debug, new)]
pub struct ServerState {
    pub dbs: HashMap<u32, HyperlaneRocksDB>,
}

impl ServerState {
    pub fn router(self) -> Router {
        Router::new()
            .route("/messages", post(handler))
            .with_state(self)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Message {
    pub version: u8,
    pub nonce: u32,
    pub origin: u32,
    pub sender: H256,
    pub destination: u32,
    pub recipient: H256,
    pub body: Vec<u8>,

    pub dispatched_block_number: u64,
}

/// Request Body
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RequestBody {
    pub messages: Vec<Message>,
}

/// Response Body
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResponseBody {
    pub count: u64,
}

/// Response Body on failure
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResponseErrorBody {
    pub message: String,
}

/// Manually insert messages into the database
pub async fn handler(
    State(state): State<ServerState>,
    Json(payload): Json<RequestBody>,
) -> ServerResult<ServerSuccessResponse<ResponseBody>, ResponseErrorBody> {
    let RequestBody { messages } = payload;

    let mut insertion_count: u64 = 0;
    for message in messages {
        let hyperlane_message = HyperlaneMessage {
            version: message.version,
            nonce: message.nonce,
            origin: message.origin,
            sender: message.sender,
            destination: message.destination,
            recipient: message.recipient,
            body: message.body,
        };

        tracing::debug!(?hyperlane_message, "Manually inserting message");

        let dispatched_block_number = message.dispatched_block_number;
        match state.dbs.get(&hyperlane_message.origin) {
            Some(db) => {
                store_message(db, &hyperlane_message, dispatched_block_number)?;
                insertion_count += 1;
            }
            None => {
                tracing::debug!(?hyperlane_message, "No db found for origin");
            }
        }
    }

    let resp = ResponseBody {
        count: insertion_count,
    };
    Ok(ServerSuccessResponse::new(resp))
}

fn store_message(
    db: &HyperlaneRocksDB,
    message: &HyperlaneMessage,
    dispatched_block_number: u64,
) -> ServerResult<(), ResponseErrorBody> {
    let id = message.id();
    tracing::debug!(hyp_message=?message, "Storing new message in db");

    db.store_message_by_id(&id, message).map_err(|err| {
        let error_msg = "Failed to store message by id";
        tracing::debug!(message_id=?id, ?err, "{error_msg}");
        ServerErrorResponse::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ResponseErrorBody {
                message: error_msg.to_string(),
            },
        )
    })?;
    db.store_message_id_by_nonce(&message.nonce, &id)
        .map_err(|err| {
            let error_msg = "Failed to store message id by nonce";
            tracing::debug!(message_id=?id, ?err, "{error_msg}");
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ResponseErrorBody {
                    message: error_msg.to_string(),
                },
            )
        })?;
    db.store_dispatched_block_number_by_nonce(&message.nonce, &dispatched_block_number)
        .map_err(|err| {
            let error_msg = "Failed to store message dispatched block number by nonce";
            tracing::debug!(message_id=?id, ?err, "{error_msg}");
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ResponseErrorBody {
                    message: error_msg.to_string(),
                },
            )
        })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{header::CONTENT_TYPE, Method, Request, Response, StatusCode},
    };
    use tower::ServiceExt;

    use hyperlane_base::db::DB;
    use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain};

    use crate::test_utils::request::parse_body_to_json;

    use super::*;

    #[derive(Debug)]
    struct TestServerSetup {
        pub app: Router,
        pub dbs: HashMap<u32, HyperlaneRocksDB>,
    }

    fn setup_test_server(domains: &[HyperlaneDomain]) -> TestServerSetup {
        let dbs: HashMap<_, _> = domains
            .iter()
            .map(|domain| {
                let temp_dir = tempfile::tempdir().unwrap();
                let db = DB::from_path(temp_dir.path()).unwrap();
                let base_db = HyperlaneRocksDB::new(domain, db);
                (domain.id(), base_db)
            })
            .collect();

        let server_state = ServerState::new(dbs.clone());
        let app = server_state.router();

        TestServerSetup { app, dbs }
    }

    async fn send_request(app: Router, body: &RequestBody) -> Response<Body> {
        let api_url = "/messages";
        let request = Request::builder()
            .uri(api_url)
            .method(Method::POST)
            .header(CONTENT_TYPE, "application/json")
            .body(serde_json::to_string(body).expect("Failed to serialize body"))
            .expect("Failed to build request");
        let response = app.oneshot(request).await.expect("Failed to send request");
        response
    }

    fn get_message(
        dbs: &HashMap<u32, HyperlaneRocksDB>,
        domain: &HyperlaneDomain,
        nonce: u32,
    ) -> HyperlaneMessage {
        dbs.get(&domain.id())
            .expect("DB not found")
            .retrieve_message_by_nonce(nonce)
            .expect("DB Error")
            .expect("Message not found")
            .clone()
    }

    #[tokio::test]
    async fn test_insert_messages_empty_db() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, dbs } = setup_test_server(domains);

        let body = RequestBody {
            messages: vec![
                Message {
                    version: 0,
                    nonce: 100,
                    origin: domains[0].id(),
                    sender: H256::from_low_u64_be(100),
                    destination: domains[1].id(),
                    recipient: H256::from_low_u64_be(200),
                    body: Vec::new(),
                    dispatched_block_number: 1000,
                },
                Message {
                    version: 0,
                    nonce: 100,
                    origin: domains[1].id(),
                    sender: H256::from_low_u64_be(100),
                    destination: domains[2].id(),
                    recipient: H256::from_low_u64_be(200),
                    body: Vec::new(),
                    dispatched_block_number: 1000,
                },
            ],
        };
        let response = send_request(app, &body).await;
        let resp_status = response.status();
        let resp_body: ResponseBody = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_status, StatusCode::OK);
        assert_eq!(resp_body.count, body.messages.len() as u64);

        let actual_messages = vec![
            get_message(&dbs, &domains[0], 100),
            get_message(&dbs, &domains[1], 100),
        ];

        for (actual, expected) in actual_messages.iter().zip(body.messages.iter()) {
            let expected_message = HyperlaneMessage {
                version: expected.version,
                nonce: expected.nonce,
                origin: expected.origin,
                sender: expected.sender,
                destination: expected.destination,
                recipient: expected.recipient,
                body: expected.body.clone(),
            };

            assert_eq!(*actual, expected_message);
        }
    }

    /// make sure overwriting messages work
    #[tokio::test]
    async fn test_insert_messages_message_already_exists() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, dbs } = setup_test_server(domains);

        // first insert some messages
        let body = RequestBody {
            messages: vec![
                Message {
                    version: 0,
                    nonce: 100,
                    origin: domains[0].id(),
                    sender: H256::from_low_u64_be(100),
                    destination: domains[1].id(),
                    recipient: H256::from_low_u64_be(200),
                    body: Vec::new(),
                    dispatched_block_number: 1000,
                },
                Message {
                    version: 0,
                    nonce: 100,
                    origin: domains[1].id(),
                    sender: H256::from_low_u64_be(100),
                    destination: domains[2].id(),
                    recipient: H256::from_low_u64_be(200),
                    body: Vec::new(),
                    dispatched_block_number: 1000,
                },
            ],
        };
        let response = send_request(app.clone(), &body).await;
        let resp_status = response.status();
        let resp_body: ResponseBody = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_status, StatusCode::OK);
        assert_eq!(resp_body.count, body.messages.len() as u64);

        // then insert some messages to overwrite previously inserted messages
        let body = RequestBody {
            messages: vec![
                Message {
                    version: 0,
                    nonce: 100,
                    origin: domains[0].id(),
                    sender: H256::from_low_u64_be(1000),
                    destination: domains[1].id(),
                    recipient: H256::from_low_u64_be(2000),
                    body: Vec::new(),
                    dispatched_block_number: 2000,
                },
                Message {
                    version: 0,
                    nonce: 100,
                    origin: domains[1].id(),
                    sender: H256::from_low_u64_be(1000),
                    destination: domains[2].id(),
                    recipient: H256::from_low_u64_be(2000),
                    body: Vec::new(),
                    dispatched_block_number: 2000,
                },
            ],
        };
        let response = send_request(app.clone(), &body).await;
        let resp_status = response.status();
        let resp_body: ResponseBody = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_status, StatusCode::OK);
        assert_eq!(resp_body.count, body.messages.len() as u64);

        let actual_messages = vec![
            get_message(&dbs, &domains[0], 100),
            get_message(&dbs, &domains[1], 100),
        ];

        for (actual, expected) in actual_messages.iter().zip(body.messages.iter()) {
            let expected_message = HyperlaneMessage {
                version: expected.version,
                nonce: expected.nonce,
                origin: expected.origin,
                sender: expected.sender,
                destination: expected.destination,
                recipient: expected.recipient,
                body: expected.body.clone(),
            };

            assert_eq!(*actual, expected_message);
        }
    }

    /// some messages aren't inserted if database is not found
    #[tokio::test]
    async fn test_insert_messages_db_not_found() {
        let domains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
        let TestServerSetup { app, dbs } = setup_test_server(domains);

        let body = RequestBody {
            messages: vec![
                Message {
                    version: 0,
                    nonce: 100,
                    origin: domains[0].id(),
                    sender: H256::from_low_u64_be(100),
                    destination: 1000,
                    recipient: H256::from_low_u64_be(200),
                    body: Vec::new(),
                    dispatched_block_number: 1000,
                },
                Message {
                    version: 0,
                    nonce: 100,
                    origin: 1000,
                    sender: H256::from_low_u64_be(100),
                    destination: 2000,
                    recipient: H256::from_low_u64_be(200),
                    body: Vec::new(),
                    dispatched_block_number: 1000,
                },
            ],
        };
        let response = send_request(app, &body).await;
        let resp_status = response.status();
        let resp_body: ResponseBody = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_status, StatusCode::OK);
        assert_eq!(resp_body.count, 1);

        let actual = get_message(&dbs, &domains[0], 100);

        let expected = HyperlaneMessage {
            version: body.messages[0].version,
            nonce: body.messages[0].nonce,
            origin: body.messages[0].origin,
            sender: body.messages[0].sender,
            destination: body.messages[0].destination,
            recipient: body.messages[0].recipient,
            body: body.messages[0].body.clone(),
        };

        assert_eq!(actual, expected);
    }
}

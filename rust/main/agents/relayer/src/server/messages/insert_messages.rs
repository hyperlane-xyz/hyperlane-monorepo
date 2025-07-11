use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};

use hyperlane_base::server::utils::{
    ServerErrorBody, ServerErrorResponse, ServerResult, ServerSuccessResponse,
};
use hyperlane_core::HyperlaneMessage;

use crate::server::messages::ServerState;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Message {
    pub message: HyperlaneMessage,
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
    pub skipped: Vec<Message>,
}

/// Manually insert messages into the database
pub async fn handler(
    State(state): State<ServerState>,
    Json(payload): Json<RequestBody>,
) -> ServerResult<ServerSuccessResponse<ResponseBody>> {
    let RequestBody { messages } = payload;

    let mut insertion_count: u64 = 0;
    let mut skipped = Vec::new();
    for message in messages {
        tracing::debug!(?message, "Manually inserting message");

        let dispatched_block_number = message.dispatched_block_number;
        match state.dbs.get(&message.message.origin) {
            Some(db) => {
                db.upsert_message(&message.message, dispatched_block_number)
                    .map_err(|err| {
                        let error_msg = "Failed to upsert message";
                        tracing::debug!(message_id=?message.message.id(), ?err, "{error_msg}");
                        ServerErrorResponse::new(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            ServerErrorBody {
                                message: error_msg.to_string(),
                            },
                        )
                    })?;
                insertion_count += 1;
            }
            None => {
                tracing::debug!(?message, "No db found for origin");
                skipped.push(message);
            }
        }
    }

    let resp = ResponseBody {
        count: insertion_count,
        skipped,
    };
    Ok(ServerSuccessResponse::new(resp))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use axum::{
        body::Body,
        http::{header::CONTENT_TYPE, Method, Request, Response, StatusCode},
        Router,
    };
    use tower::ServiceExt;

    use hyperlane_base::db::{HyperlaneRocksDB, DB};
    use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, H256};

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
                    message: HyperlaneMessage {
                        version: 0,
                        nonce: 100,
                        origin: domains[0].id(),
                        sender: H256::from_low_u64_be(100),
                        destination: domains[1].id(),
                        recipient: H256::from_low_u64_be(200),
                        body: Vec::new(),
                    },
                    dispatched_block_number: 1000,
                },
                Message {
                    message: HyperlaneMessage {
                        version: 0,
                        nonce: 100,
                        origin: domains[1].id(),
                        sender: H256::from_low_u64_be(100),
                        destination: domains[2].id(),
                        recipient: H256::from_low_u64_be(200),
                        body: Vec::new(),
                    },
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
            assert_eq!(*actual, expected.message);
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
                    message: HyperlaneMessage {
                        version: 0,
                        nonce: 100,
                        origin: domains[0].id(),
                        sender: H256::from_low_u64_be(100),
                        destination: domains[1].id(),
                        recipient: H256::from_low_u64_be(200),
                        body: Vec::new(),
                    },
                    dispatched_block_number: 1000,
                },
                Message {
                    message: HyperlaneMessage {
                        version: 0,
                        nonce: 100,
                        origin: domains[1].id(),
                        sender: H256::from_low_u64_be(100),
                        destination: domains[2].id(),
                        recipient: H256::from_low_u64_be(200),
                        body: Vec::new(),
                    },
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
                    message: HyperlaneMessage {
                        version: 0,
                        nonce: 100,
                        origin: domains[0].id(),
                        sender: H256::from_low_u64_be(1000),
                        destination: domains[1].id(),
                        recipient: H256::from_low_u64_be(2000),
                        body: Vec::new(),
                    },
                    dispatched_block_number: 2000,
                },
                Message {
                    message: HyperlaneMessage {
                        version: 0,
                        nonce: 100,
                        origin: domains[1].id(),
                        sender: H256::from_low_u64_be(1000),
                        destination: domains[2].id(),
                        recipient: H256::from_low_u64_be(2000),
                        body: Vec::new(),
                    },
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
            assert_eq!(*actual, expected.message);
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
                    message: HyperlaneMessage {
                        version: 0,
                        nonce: 100,
                        origin: domains[0].id(),
                        sender: H256::from_low_u64_be(100),
                        destination: 1000,
                        recipient: H256::from_low_u64_be(200),
                        body: Vec::new(),
                    },
                    dispatched_block_number: 1000,
                },
                Message {
                    message: HyperlaneMessage {
                        version: 0,
                        nonce: 100,
                        origin: 1000,
                        sender: H256::from_low_u64_be(100),
                        destination: 2000,
                        recipient: H256::from_low_u64_be(200),
                        body: Vec::new(),
                    },
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

        let expected = &body.messages[0].message;
        assert_eq!(actual, *expected);
    }
}

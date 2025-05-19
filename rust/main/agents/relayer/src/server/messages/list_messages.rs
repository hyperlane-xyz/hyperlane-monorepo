use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::get,
    Router,
};
use derive_new::new;
use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_core::H256;
use serde::{Deserialize, Serialize};

use crate::server::utils::{ServerErrorResponse, ServerResult, ServerSuccessResponse};

#[derive(Clone, Debug, new)]
pub struct ServerState {
    pub dbs: HashMap<u32, HyperlaneRocksDB>,
}

impl ServerState {
    pub fn router(self) -> Router {
        Router::new()
            .route("/messages", get(handler))
            .with_state(self)
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct QueryParams {
    pub domain_id: u32,
    pub nonce_start: u32,
    pub nonce_end: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Message {
    pub version: u8,
    pub nonce: u32,
    pub origin: u32,
    pub sender: H256,
    pub destination: u32,
    pub recipient: H256,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResponseBody {
    pub messages: Vec<Message>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResponseErrorBody {
    pub message: String,
}

/// Fetch merkle tree insertion into the database
pub async fn handler(
    State(state): State<ServerState>,
    Query(query_params): Query<QueryParams>,
) -> ServerResult<ServerSuccessResponse<ResponseBody>, ResponseErrorBody> {
    let QueryParams {
        domain_id,
        nonce_start,
        nonce_end,
    } = query_params;

    tracing::debug!(domain_id, nonce_start, nonce_end, "Fetching messages");

    if nonce_end <= nonce_start {
        let error_msg = "nonce_end less than nonce_start";
        let err = ServerErrorResponse::new(
            StatusCode::BAD_REQUEST,
            ResponseErrorBody {
                message: error_msg.to_string(),
            },
        );
        return Err(err);
    }

    let db = state.dbs.get(&domain_id).ok_or_else(|| {
        let error_msg = "No db found for chain";
        tracing::debug!(domain_id, "{error_msg}");
        ServerErrorResponse::new(
            StatusCode::NOT_FOUND,
            ResponseErrorBody {
                message: error_msg.to_string(),
            },
        )
    })?;

    let mut messages = Vec::with_capacity((nonce_end - nonce_start) as usize);
    for nonce in nonce_start..nonce_end {
        let retrieve_res = db.retrieve_message_by_nonce(nonce).map_err(|err| {
            let error_msg = "Failed to fetch message";
            tracing::debug!(domain_id, nonce, ?err, "{error_msg}");
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ResponseErrorBody {
                    message: error_msg.to_string(),
                },
            )
        })?;
        if let Some(msg) = retrieve_res {
            let message = Message {
                version: msg.version,
                nonce: msg.nonce,
                origin: msg.origin,
                sender: msg.sender,
                destination: msg.destination,
                recipient: msg.recipient,
                body: msg.body,
            };
            messages.push(message);
        }
    }

    let resp = ResponseBody { messages };
    Ok(ServerSuccessResponse::new(resp))
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{self, Body},
        http::{header::CONTENT_TYPE, Request, Response, StatusCode},
    };
    use tower::ServiceExt;

    use hyperlane_base::db::DB;
    use hyperlane_core::{HyperlaneDomain, HyperlaneMessage, KnownHyperlaneDomain, H256};

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

    async fn send_request(
        app: Router,
        domain_id: u32,
        nonce_start: u32,
        nonce_end: u32,
    ) -> Response<Body> {
        let api_url = format!(
            "/messages?domain_id={domain_id}&nonce_start={nonce_start}&nonce_end={nonce_end}"
        );
        let request = Request::builder()
            .uri(api_url)
            .header(CONTENT_TYPE, "application/json")
            .body(body::Body::empty())
            .expect("Failed to build request");
        let response = app.oneshot(request).await.expect("Failed to send request");
        response
    }

    fn insert_message(
        dbs: &HashMap<u32, HyperlaneRocksDB>,
        domain: &HyperlaneDomain,
        message: &HyperlaneMessage,
        dispatched_block_number: u64,
    ) {
        dbs.get(&domain.id())
            .expect("DB not found")
            .store_message(&message, dispatched_block_number)
            .expect("DB Error");
    }

    #[tokio::test]
    async fn test_list_messages_db_not_found() {
        let domains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
        let TestServerSetup { app, .. } = setup_test_server(domains);

        let nonce_start = 100;
        let nonce_end = 103;
        let response = send_request(app.clone(), 1000, nonce_start, nonce_end).await;
        let resp_status = response.status();

        assert_eq!(resp_status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_list_messages_empty_db() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, .. } = setup_test_server(domains);

        let nonce_start = 100;
        let nonce_end = 120;
        let response = send_request(app, domains[0].id(), nonce_start, nonce_end).await;
        let resp_status = response.status();
        let resp_body: ResponseBody = parse_body_to_json(response.into_body()).await;

        assert_eq!(resp_status, StatusCode::OK);
        assert!(resp_body.messages.is_empty());
    }

    #[tokio::test]
    async fn test_list_messages_happy_path() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, dbs } = setup_test_server(domains);

        let insertions = [
            (
                1000,
                HyperlaneMessage {
                    version: 0,
                    nonce: 100,
                    origin: domains[0].id(),
                    sender: H256::from_low_u64_be(100),
                    destination: domains[1].id(),
                    recipient: H256::from_low_u64_be(200),
                    body: Vec::new(),
                },
            ),
            (
                1001,
                HyperlaneMessage {
                    version: 0,
                    nonce: 101,
                    origin: domains[0].id(),
                    sender: H256::from_low_u64_be(101),
                    destination: domains[1].id(),
                    recipient: H256::from_low_u64_be(201),
                    body: Vec::new(),
                },
            ),
        ];

        for (dispatched_block_number, message) in insertions.iter() {
            insert_message(&dbs, &domains[0], message, *dispatched_block_number);
        }

        let nonce_start = 100;
        let nonce_end = 103;
        let response = send_request(app.clone(), domains[0].id(), nonce_start, nonce_end).await;

        let resp_status = response.status();
        let resp_body: ResponseBody = parse_body_to_json(response.into_body()).await;

        assert_eq!(resp_status, StatusCode::OK);

        let expected_list: Vec<_> = insertions
            .iter()
            .map(|(_, msg)| Message {
                version: msg.version,
                nonce: msg.nonce,
                origin: msg.origin,
                sender: msg.sender,
                destination: msg.destination,
                recipient: msg.recipient,
                body: msg.body.clone(),
            })
            .collect();

        assert_eq!(resp_body.messages.len(), expected_list.len());
        for (actual, expected) in resp_body.messages.iter().zip(expected_list.iter()) {
            assert_eq!(actual, expected);
        }
    }
}

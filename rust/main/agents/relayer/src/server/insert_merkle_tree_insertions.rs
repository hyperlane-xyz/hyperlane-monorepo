use std::collections::HashMap;

use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use derive_new::new;
use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_core::{MerkleTreeInsertion, H256};
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
            .route("/merkle_tree_insertions", post(handler))
            .with_state(self)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TreeInsertion {
    pub chain: u32,
    pub insertion_block_number: u64,

    pub leaf_index: u32,
    pub message_id: H256,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RequestBody {
    pub merkle_tree_insertions: Vec<TreeInsertion>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResponseBody {
    pub count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResponseErrorBody {
    pub message: String,
}

/// Manually insert merkle tree insertion into the database
pub async fn handler(
    State(state): State<ServerState>,
    Json(payload): Json<RequestBody>,
) -> ServerResult<ServerSuccessResponse<ResponseBody>, ResponseErrorBody> {
    let RequestBody {
        merkle_tree_insertions,
    } = payload;

    let mut insertion_count: u64 = 0;
    for insertion in merkle_tree_insertions {
        let merkle_tree_insertion =
            MerkleTreeInsertion::new(insertion.leaf_index, insertion.message_id);

        tracing::debug!(?insertion, "Manually inserting merkle tree insertion");

        match state.dbs.get(&insertion.chain) {
            Some(db) => {
                db.store_tree_insertion(&merkle_tree_insertion, insertion.insertion_block_number)
                    .map_err(|err| {
                        let error_msg = "Failed to store merkle tree insertion";
                        tracing::debug!(?insertion, ?err, "{error_msg}");
                        ServerErrorResponse::new(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            ResponseErrorBody {
                                message: error_msg.to_string(),
                            },
                        )
                    })?;
                insertion_count += 1;
            }
            None => {
                tracing::debug!(?insertion, "No db found for chain");
            }
        }
    }

    let resp = ResponseBody {
        count: insertion_count,
    };
    Ok(ServerSuccessResponse::new(resp))
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{header::CONTENT_TYPE, Method, Request, Response, StatusCode},
    };
    use tower::ServiceExt;

    use hyperlane_base::db::{HyperlaneDb, DB};
    use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain};

    use super::*;
    use crate::test_utils::request::parse_body_to_json;

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
        let api_url = "/merkle_tree_insertions";
        let request = Request::builder()
            .uri(api_url)
            .method(Method::POST)
            .header(CONTENT_TYPE, "application/json")
            .body(serde_json::to_string(body).expect("Failed to serialize body"))
            .expect("Failed to build request");
        let response = app.oneshot(request).await.expect("Failed to send request");
        response
    }

    fn get_merkle_tree_insertion(
        dbs: &HashMap<u32, HyperlaneRocksDB>,
        domain: &HyperlaneDomain,
        leaf_index: u32,
    ) -> MerkleTreeInsertion {
        dbs.get(&domain.id())
            .expect("DB not found")
            .retrieve_merkle_tree_insertion_by_leaf_index(&leaf_index)
            .expect("DB Error")
            .expect("Message not found")
            .clone()
    }

    fn get_merkle_tree_insertion_block_number(
        dbs: &HashMap<u32, HyperlaneRocksDB>,
        domain: &HyperlaneDomain,
        leaf_index: u32,
    ) -> u64 {
        dbs.get(&domain.id())
            .expect("DB not found")
            .retrieve_merkle_tree_insertion_block_number_by_leaf_index(&leaf_index)
            .expect("DB Error")
            .expect("Message not found")
    }

    #[tokio::test]
    async fn test_insert_merkle_tree_insertions_empty_db() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, dbs } = setup_test_server(domains);

        let body = RequestBody {
            merkle_tree_insertions: vec![
                TreeInsertion {
                    leaf_index: 100,
                    message_id: H256::from_low_u64_be(1000),

                    chain: domains[0].id(),
                    insertion_block_number: 100,
                },
                TreeInsertion {
                    leaf_index: 100,
                    message_id: H256::from_low_u64_be(1000),

                    chain: domains[1].id(),
                    insertion_block_number: 100,
                },
            ],
        };
        let response = send_request(app, &body).await;
        let resp_status = response.status();
        let resp_body: ResponseBody = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_status, StatusCode::OK);
        assert_eq!(resp_body.count, body.merkle_tree_insertions.len() as u64);

        // check db has correct merkle tree insertions
        let actual = vec![
            get_merkle_tree_insertion(&dbs, &domains[0], 100),
            get_merkle_tree_insertion(&dbs, &domains[1], 100),
        ];
        for (actual, expected) in actual.iter().zip(body.merkle_tree_insertions.iter()) {
            let expected_message =
                MerkleTreeInsertion::new(expected.leaf_index, expected.message_id);
            assert_eq!(*actual, expected_message);
        }

        // check db has correct merkle tree insertion block number
        let actual = vec![
            get_merkle_tree_insertion_block_number(&dbs, &domains[0], 100),
            get_merkle_tree_insertion_block_number(&dbs, &domains[1], 100),
        ];
        for (actual, expected) in actual.iter().zip(body.merkle_tree_insertions.iter()) {
            assert_eq!(*actual, expected.insertion_block_number);
        }
    }

    #[tokio::test]
    async fn test_insert_merkle_tree_insertions_already_exists() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, dbs } = setup_test_server(domains);

        let body = RequestBody {
            merkle_tree_insertions: vec![
                TreeInsertion {
                    leaf_index: 100,
                    message_id: H256::from_low_u64_be(1000),

                    chain: domains[0].id(),
                    insertion_block_number: 100,
                },
                TreeInsertion {
                    leaf_index: 100,
                    message_id: H256::from_low_u64_be(1000),

                    chain: domains[1].id(),
                    insertion_block_number: 100,
                },
            ],
        };
        let response = send_request(app.clone(), &body).await;
        let resp_status = response.status();
        let resp_body: ResponseBody = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_status, StatusCode::OK);
        assert_eq!(resp_body.count, body.merkle_tree_insertions.len() as u64);

        let body = RequestBody {
            merkle_tree_insertions: vec![
                TreeInsertion {
                    leaf_index: 100,
                    message_id: H256::from_low_u64_be(1000),

                    chain: domains[0].id(),
                    insertion_block_number: 100,
                },
                TreeInsertion {
                    leaf_index: 100,
                    message_id: H256::from_low_u64_be(1000),

                    chain: domains[1].id(),
                    insertion_block_number: 100,
                },
            ],
        };
        let response = send_request(app.clone(), &body).await;
        let resp_status = response.status();
        let resp_body: ResponseBody = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_status, StatusCode::OK);
        assert_eq!(resp_body.count, body.merkle_tree_insertions.len() as u64);

        // check db has correct merkle tree insertions
        let actual = vec![
            get_merkle_tree_insertion(&dbs, &domains[0], 100),
            get_merkle_tree_insertion(&dbs, &domains[1], 100),
        ];
        for (actual, expected) in actual.iter().zip(body.merkle_tree_insertions.iter()) {
            let expected_message =
                MerkleTreeInsertion::new(expected.leaf_index, expected.message_id);
            assert_eq!(*actual, expected_message);
        }

        // check db has correct merkle tree insertion block number
        let actual = vec![
            get_merkle_tree_insertion_block_number(&dbs, &domains[0], 100),
            get_merkle_tree_insertion_block_number(&dbs, &domains[1], 100),
        ];
        for (actual, expected) in actual.iter().zip(body.merkle_tree_insertions.iter()) {
            assert_eq!(*actual, expected.insertion_block_number);
        }
    }

    #[tokio::test]
    async fn test_insert_merkle_tree_insertions_db_not_found() {
        let domains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
        let TestServerSetup { app, dbs } = setup_test_server(domains);

        let body = RequestBody {
            merkle_tree_insertions: vec![
                TreeInsertion {
                    leaf_index: 100,
                    message_id: H256::from_low_u64_be(1000),

                    chain: domains[0].id(),
                    insertion_block_number: 100,
                },
                TreeInsertion {
                    leaf_index: 100,
                    message_id: H256::from_low_u64_be(1000),

                    chain: 1000,
                    insertion_block_number: 100,
                },
            ],
        };
        let response = send_request(app, &body).await;
        let resp_status = response.status();
        let resp_body: ResponseBody = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_status, StatusCode::OK);
        assert_eq!(resp_body.count, 1);

        let actual = get_merkle_tree_insertion(&dbs, &domains[0], 100);

        let expected = MerkleTreeInsertion::new(
            body.merkle_tree_insertions[0].leaf_index,
            body.merkle_tree_insertions[0].message_id,
        );

        assert_eq!(actual, expected);
    }
}

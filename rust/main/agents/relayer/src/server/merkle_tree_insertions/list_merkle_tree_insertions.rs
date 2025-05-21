use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::get,
    Router,
};
use derive_new::new;
use serde::{Deserialize, Serialize};

use hyperlane_base::db::{HyperlaneDb, HyperlaneRocksDB};

use crate::server::utils::{ServerErrorResponse, ServerResult, ServerSuccessResponse};

#[derive(Clone, Debug, new)]
pub struct ServerState {
    pub dbs: HashMap<u32, HyperlaneRocksDB>,
}

impl ServerState {
    pub fn router(self) -> Router {
        Router::new()
            .route("/merkle_tree_insertions", get(handler))
            .with_state(self)
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct QueryParams {
    pub domain_id: u32,
    pub leaf_index_start: u32,
    pub leaf_index_end: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct TreeInsertion {
    pub leaf_index: u32,
    pub message_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResponseBody {
    pub merkle_tree_insertions: Vec<TreeInsertion>,
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
        leaf_index_start,
        leaf_index_end,
    } = query_params;

    tracing::debug!(
        domain_id,
        leaf_index_start,
        leaf_index_end,
        "Fetching merkle tree insertion"
    );

    if leaf_index_end <= leaf_index_start {
        let error_msg = "leaf_index_end less than leaf_index_start";
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

    let mut merkle_tree_insertions =
        Vec::with_capacity((leaf_index_end - leaf_index_start) as usize);
    for leaf_index in leaf_index_start..leaf_index_end {
        let retrieve_res = db
            .retrieve_merkle_tree_insertion_by_leaf_index(&leaf_index)
            .map_err(|err| {
                let error_msg = "Failed to fetch merkle tree insertion";
                tracing::debug!(domain_id, leaf_index, ?err, "{error_msg}");
                ServerErrorResponse::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ResponseErrorBody {
                        message: error_msg.to_string(),
                    },
                )
            })?;
        if let Some(insertion) = retrieve_res {
            let tree_insertion = TreeInsertion {
                leaf_index: insertion.index(),
                message_id: format!("{:?}", insertion.message_id()),
            };
            merkle_tree_insertions.push(tree_insertion);
        }
    }

    let resp = ResponseBody {
        merkle_tree_insertions,
    };
    Ok(ServerSuccessResponse::new(resp))
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{self, Body},
        http::{header::CONTENT_TYPE, Request, Response, StatusCode},
    };
    use tower::ServiceExt;

    use hyperlane_base::db::{HyperlaneDb, DB};
    use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, MerkleTreeInsertion, H256};

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
        leaf_index_start: u32,
        leaf_index_end: u32,
    ) -> Response<Body> {
        let api_url = format!("/merkle_tree_insertions?domain_id={domain_id}&leaf_index_start={leaf_index_start}&leaf_index_end={leaf_index_end}");
        let request = Request::builder()
            .uri(api_url)
            .header(CONTENT_TYPE, "application/json")
            .body(body::Body::empty())
            .expect("Failed to build request");
        let response = app.oneshot(request).await.expect("Failed to send request");
        response
    }

    fn insert_merkle_tree_insertion(
        dbs: &HashMap<u32, HyperlaneRocksDB>,
        domain: &HyperlaneDomain,
        leaf_index: u32,
        insertion: &MerkleTreeInsertion,
    ) {
        dbs.get(&domain.id())
            .expect("DB not found")
            .store_merkle_tree_insertion_by_leaf_index(&leaf_index, &insertion)
            .expect("DB Error")
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_list_merkle_tree_insertions_db_not_found() {
        let domains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
        let TestServerSetup { app, .. } = setup_test_server(domains);

        let leaf_index_start = 100;
        let leaf_index_end = 103;
        let response = send_request(app.clone(), 1000, leaf_index_start, leaf_index_end).await;
        let resp_status = response.status();

        assert_eq!(resp_status, StatusCode::NOT_FOUND);
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_list_merkle_tree_insertions_empty_db() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, .. } = setup_test_server(domains);

        let leaf_index_start = 100;
        let leaf_index_end = 120;
        let response = send_request(app, domains[0].id(), leaf_index_start, leaf_index_end).await;
        let resp_status = response.status();
        let resp_body: ResponseBody = parse_body_to_json(response.into_body()).await;

        assert_eq!(resp_status, StatusCode::OK);
        assert!(resp_body.merkle_tree_insertions.is_empty());
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_list_merkle_tree_insertions_happy_path() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, dbs } = setup_test_server(domains);

        let insertions = [
            MerkleTreeInsertion::new(100, H256::from_low_u64_be(100)),
            MerkleTreeInsertion::new(101, H256::from_low_u64_be(101)),
            MerkleTreeInsertion::new(102, H256::from_low_u64_be(102)),
        ];

        for insertion in insertions.iter() {
            insert_merkle_tree_insertion(&dbs, &domains[0], insertion.index(), insertion);
        }

        let leaf_index_start = 100;
        let leaf_index_end = 103;
        let response = send_request(
            app.clone(),
            domains[0].id(),
            leaf_index_start,
            leaf_index_end,
        )
        .await;

        let resp_status = response.status();
        let body = response.into_body();
        println!("Response body: {:?}", body);
        let resp_body: ResponseBody = parse_body_to_json(body).await;

        assert_eq!(resp_status, StatusCode::OK);

        let expected_list = [
            TreeInsertion {
                leaf_index: 100,
                message_id: format!("{:x}", H256::from_low_u64_be(100)),
            },
            TreeInsertion {
                leaf_index: 101,
                message_id: format!("{:x}", H256::from_low_u64_be(101)),
            },
            TreeInsertion {
                leaf_index: 102,
                message_id: format!("{:x}", H256::from_low_u64_be(102)),
            },
        ];

        assert_eq!(resp_body.merkle_tree_insertions.len(), expected_list.len());
        for (actual, expected) in resp_body
            .merkle_tree_insertions
            .iter()
            .zip(expected_list.iter())
        {
            assert_eq!(actual, expected);
        }
    }
}

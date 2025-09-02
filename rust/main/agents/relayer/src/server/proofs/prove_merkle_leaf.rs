use axum::{
    extract::{Query, State},
    http::StatusCode,
};
use ethers::utils::hex;
use hyperlane_core::accumulator::merkle::Proof;
use serde::{Deserialize, Serialize};

use hyperlane_base::server::utils::{
    ServerErrorBody, ServerErrorResponse, ServerResult, ServerSuccessResponse,
};

use super::ServerState;

#[derive(Clone, Debug, Deserialize)]
pub struct QueryParams {
    pub domain_id: u32,
    pub leaf_index: u32,
    pub root_index: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResponseBody {
    pub proof: Proof,
    pub root: String,
}

/// Generate merkle proof
pub async fn handler(
    State(state): State<ServerState>,
    Query(query_params): Query<QueryParams>,
) -> ServerResult<ServerSuccessResponse<ResponseBody>> {
    let QueryParams {
        domain_id,
        leaf_index,
        root_index,
    } = query_params;

    tracing::debug!(
        domain_id,
        leaf_index,
        root_index,
        "Calculating merkle proof",
    );

    let origin_prove_sync = state.origin_prover_syncs.get(&domain_id).ok_or_else(|| {
        tracing::debug!(domain_id, "Domain does not exist");
        ServerErrorResponse::new(
            StatusCode::NOT_FOUND,
            ServerErrorBody {
                message: format!("Domain {domain_id} does not exist"),
            },
        )
    })?;

    let proof = origin_prove_sync
        .read()
        .await
        .get_proof(leaf_index, root_index)
        .map_err(|err| {
            tracing::error!(leaf_index, root_index, ?err, "Failed to get proof");
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ServerErrorBody {
                    message: err.to_string(),
                },
            )
        })?;

    let root = hex::encode(proof.root());
    let resp = ResponseBody { proof, root };
    Ok(ServerSuccessResponse::new(resp))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use axum::{
        body::{self, Body},
        http::{header::CONTENT_TYPE, Request, Response, StatusCode},
        Router,
    };
    use tower::ServiceExt;

    use hyperlane_base::db::{HyperlaneDb, HyperlaneRocksDB, DB};
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

    fn insert_merkle_tree_insertion_block_number(
        dbs: &HashMap<u32, HyperlaneRocksDB>,
        domain: &HyperlaneDomain,
        leaf_index: u32,
        block_number: u64,
    ) {
        dbs.get(&domain.id())
            .expect("DB not found")
            .store_merkle_tree_insertion_block_number_by_leaf_index(&leaf_index, &block_number)
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
            MerkleTreeInsertion::new(103, H256::from_low_u64_be(103)),
        ];

        for insertion in insertions.iter() {
            insert_merkle_tree_insertion(&dbs, &domains[0], insertion.index(), insertion);
        }
        for insertion in insertions.iter().take(2) {
            insert_merkle_tree_insertion_block_number(&dbs, &domains[0], insertion.index(), 100);
        }

        let leaf_index_start = 100;
        let leaf_index_end = 102;
        let response = send_request(
            app.clone(),
            domains[0].id(),
            leaf_index_start,
            leaf_index_end,
        )
        .await;

        let resp_status = response.status();
        let resp_body: ResponseBody = parse_body_to_json(response.into_body()).await;

        assert_eq!(resp_status, StatusCode::OK);

        let expected_list = [
            TreeInsertion {
                insertion_block_number: Some(100),
                leaf_index: 100,
                message_id: format!("{:?}", H256::from_low_u64_be(100)),
            },
            TreeInsertion {
                insertion_block_number: Some(100),
                leaf_index: 101,
                message_id: format!("{:?}", H256::from_low_u64_be(101)),
            },
            TreeInsertion {
                insertion_block_number: None,
                leaf_index: 102,
                message_id: format!("{:?}", H256::from_low_u64_be(102)),
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

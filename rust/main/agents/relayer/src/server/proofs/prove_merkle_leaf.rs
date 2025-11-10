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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
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
    use std::{collections::HashMap, sync::Arc};

    use axum::{
        body::{self, Body},
        http::{header::CONTENT_TYPE, Request, Response, StatusCode},
        Router,
    };
    use tokio::sync::RwLock;
    use tower::ServiceExt;

    use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, H256};

    use super::*;
    use crate::{merkle_tree::builder::MerkleTreeBuilder, test_utils::request::parse_body_to_json};

    #[derive(Debug)]
    struct TestServerSetup {
        pub app: Router,
        pub origin_prover_syncs: HashMap<u32, Arc<RwLock<MerkleTreeBuilder>>>,
    }

    fn setup_test_server(domains: &[HyperlaneDomain]) -> TestServerSetup {
        let origin_prover_syncs: HashMap<u32, Arc<RwLock<MerkleTreeBuilder>>> = domains
            .iter()
            .map(|domain| {
                let merkle_tree_builder = MerkleTreeBuilder::new();
                (domain.id(), Arc::new(RwLock::new(merkle_tree_builder)))
            })
            .collect();

        let server_state = ServerState::new(origin_prover_syncs.clone());
        let app = server_state.router();

        TestServerSetup {
            app,
            origin_prover_syncs,
        }
    }

    async fn send_request(
        app: Router,
        domain_id: u32,
        leaf_index: u32,
        root_index: u32,
    ) -> Response<Body> {
        let api_url = format!(
            "/merkle_proofs?domain_id={domain_id}&leaf_index={leaf_index}&root_index={root_index}"
        );
        let request = Request::builder()
            .uri(api_url)
            .header(CONTENT_TYPE, "application/json")
            .body(body::Body::empty())
            .expect("Failed to build request");
        let response = app.oneshot(request).await.expect("Failed to send request");
        response
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_prove_merkle_leaf_happy_path() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup {
            app,
            mut origin_prover_syncs,
        } = setup_test_server(domains);

        {
            let prover_sync = origin_prover_syncs
                .get_mut(&(KnownHyperlaneDomain::Arbitrum as u32))
                .expect("Missing prover sync");

            let mut prover_sync_write = prover_sync.write().await;

            let _ = prover_sync_write.ingest_message_id(H256::from_low_u64_be(1000));
            let _ = prover_sync_write.ingest_message_id(H256::from_low_u64_be(2000));
            let _ = prover_sync_write.ingest_message_id(H256::from_low_u64_be(3000));
        }

        let response = send_request(app, KnownHyperlaneDomain::Arbitrum as u32, 1, 1).await;
        let resp_status = response.status();
        let resp_body: ResponseBody = parse_body_to_json(response.into_body()).await;
        assert_eq!(resp_status, StatusCode::OK);

        let expected = ResponseBody {
            proof: Proof {
                leaf: H256::from_low_u64_be(2000),
                index: 1,
                path: resp_body.proof.path,
            },
            root: "41fd56f0277eaba76a4ad043c1072239e32f0de80c6e2b6a546e73a4a1bafebd".into(),
        };
        assert_eq!(resp_body, expected);
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_prove_merkle_leaf_not_found() {
        let domains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let TestServerSetup { app, .. } = setup_test_server(domains);

        let response = send_request(app, KnownHyperlaneDomain::Arbitrum as u32, 1, 1).await;
        let resp_status = response.status();
        assert_eq!(resp_status, StatusCode::INTERNAL_SERVER_ERROR);
    }
}

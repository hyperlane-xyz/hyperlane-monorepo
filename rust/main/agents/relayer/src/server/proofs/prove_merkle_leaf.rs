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

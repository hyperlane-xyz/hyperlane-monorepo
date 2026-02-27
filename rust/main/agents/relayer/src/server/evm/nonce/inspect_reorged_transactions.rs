use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use hyperlane_base::server::utils::{
    ServerErrorBody, ServerErrorResponse, ServerResult, ServerSuccessResponse,
};
use lander::ReorgedTransactionsInspection;

use super::ServerState;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RequestBody {
    pub domain_id: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResponseBody {
    pub inspection: ReorgedTransactionsInspection,
}

/// Inspect transactions captured from an oversized reorg window.
pub async fn handler(
    State(state): State<ServerState>,
    Json(payload): Json<RequestBody>,
) -> ServerResult<ServerSuccessResponse<ResponseBody>> {
    let RequestBody { domain_id } = payload;
    debug!(domain_id, "Inspecting oversized reorg transactions");

    let dispatcher_entrypoint = state.entrypoints.get(&domain_id).ok_or_else(|| {
        warn!(domain_id, "Domain does not exist");
        ServerErrorResponse::new(
            StatusCode::NOT_FOUND,
            ServerErrorBody {
                message: format!("Domain {domain_id} does not exist"),
            },
        )
    })?;

    let inspection = dispatcher_entrypoint
        .inspect_reorged_transactions()
        .await
        .map_err(|err| {
            warn!(domain_id, ?err, "Failed to inspect reorged transactions");
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ServerErrorBody {
                    message: format!("Failed to inspect reorged transactions: {err}"),
                },
            )
        })?;

    Ok(ServerSuccessResponse::new(ResponseBody { inspection }))
}

use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use hyperlane_base::server::utils::{
    ServerErrorBody, ServerErrorResponse, ServerResult, ServerSuccessResponse,
};
use lander::LanderError;

use super::ServerState;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RequestBody {
    pub domain_id: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResponseBody {
    pub queued_transactions: usize,
}

/// Trigger manual reprocessing for transactions captured from an oversized reorg.
pub async fn handler(
    State(state): State<ServerState>,
    Json(payload): Json<RequestBody>,
) -> ServerResult<ServerSuccessResponse<ResponseBody>> {
    let RequestBody { domain_id } = payload;
    debug!(
        domain_id,
        "Triggering manual reprocessing for oversized reorg transactions"
    );

    let dispatcher_entrypoint = state.entrypoints.get(&domain_id).ok_or_else(|| {
        warn!(domain_id, "Domain does not exist");
        ServerErrorResponse::new(
            StatusCode::NOT_FOUND,
            ServerErrorBody {
                message: format!("Domain {domain_id} does not exist"),
            },
        )
    })?;

    let queued_transactions = dispatcher_entrypoint
        .trigger_reprocess_reorged_transactions()
        .await
        .map_err(|err| {
            let status = match err {
                LanderError::NonRetryableError(_) => StatusCode::BAD_REQUEST,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            warn!(
                domain_id,
                ?err,
                "Failed to trigger manual reprocessing for oversized reorg transactions"
            );
            ServerErrorResponse::new(
                status,
                ServerErrorBody {
                    message: format!("Failed to trigger reprocessing: {err}"),
                },
            )
        })?;

    Ok(ServerSuccessResponse::new(ResponseBody {
        queued_transactions,
    }))
}

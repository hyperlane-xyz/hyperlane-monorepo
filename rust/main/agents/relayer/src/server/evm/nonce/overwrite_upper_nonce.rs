use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use hyperlane_base::server::utils::{
    ServerErrorBody, ServerErrorResponse, ServerResult, ServerSuccessResponse,
};
use lander::AdaptsChainAction;

use super::ServerState;

/// Request Body
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RequestBody {
    pub domain_id: u32,
    // If provided, will set to this value.
    // If not provided, will reset upper nonce to finalized nonce.
    pub new_upper_nonce: Option<u64>,
}

/// Overwrite the upper nonce for an EVM chain
pub async fn handler(
    State(state): State<ServerState>,
    Json(payload): Json<RequestBody>,
) -> ServerResult<ServerSuccessResponse<()>> {
    let RequestBody {
        domain_id,
        new_upper_nonce,
    } = payload;

    debug!(domain_id, "Fetching chain");

    let dispatcher_entrypoint = state.entrypoints.get(&domain_id).ok_or_else(|| {
        warn!(domain_id, "Domain does not exist");
        ServerErrorResponse::new(
            StatusCode::NOT_FOUND,
            ServerErrorBody {
                message: format!("Domain {domain_id} does not exist"),
            },
        )
    })?;

    let action = AdaptsChainAction::OverwriteUpperNonce {
        nonce: new_upper_nonce,
    };

    dispatcher_entrypoint
        .execute_command(action)
        .await
        .map_err(|err| {
            warn!(
                domain_id,
                ?new_upper_nonce,
                ?err,
                "Failed to overwrite upper nonce"
            );
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ServerErrorBody {
                    message: format!("Failed to overwrite upper nonce: {err}"),
                },
            )
        })?;
    Ok(ServerSuccessResponse::new(()))
}

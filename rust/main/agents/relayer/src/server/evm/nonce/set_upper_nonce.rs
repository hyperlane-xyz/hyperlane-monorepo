use axum::{extract::State, http::StatusCode, Json};
use lander::AdaptsChainAction;
use serde::{Deserialize, Serialize};

use hyperlane_base::server::utils::{
    ServerErrorBody, ServerErrorResponse, ServerResult, ServerSuccessResponse,
};

use super::ServerState;

/// Request Body
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RequestBody {
    pub domain_id: u32,
    // If provided, will set to this value.
    // If not provided, will reset upper nonce to finalized nonce.
    pub new_upper_nonce: Option<u64>,
}

#[axum::debug_handler]
/// Reset the upper nonce for an EVM chain
pub async fn handler(
    State(state): State<ServerState>,
    Json(payload): Json<RequestBody>,
) -> ServerResult<ServerSuccessResponse<()>> {
    let RequestBody {
        domain_id,
        new_upper_nonce,
    } = payload;

    tracing::debug!(domain_id, "Fetching chain");

    let dispatcher_entrypoint = state.entrypoints.get(&domain_id).ok_or_else(|| {
        tracing::debug!(domain_id, "Domain does not exist");
        ServerErrorResponse::new(
            StatusCode::NOT_FOUND,
            ServerErrorBody {
                message: format!("Domain {domain_id} does not exist"),
            },
        )
    })?;

    let action = AdaptsChainAction::SetUpperNonce {
        nonce: new_upper_nonce,
    };

    dispatcher_entrypoint
        .execute_command(action)
        .await
        .map_err(|err| {
            tracing::debug!(
                domain_id,
                ?new_upper_nonce,
                ?err,
                "Failed to set upper nonce"
            );
            ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ServerErrorBody {
                    message: format!("Failed to set upper nonce: {err}"),
                },
            )
        })?;
    Ok(ServerSuccessResponse::new(()))
}

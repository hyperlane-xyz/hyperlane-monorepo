use axum::{
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};

use hyperlane_base::server::utils::{
    ServerErrorBody, ServerErrorResponse, ServerResult, ServerSuccessResponse,
};
use hyperlane_core::HyperlaneMessage;

use crate::server::kaspa::ServerState;

#[derive(Clone, Debug, Deserialize)]
pub struct QueryParams {
    pub message_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct WithdrawalResponse {
    pub message_id: String,
    pub message: HyperlaneMessage,
    pub kaspa_tx: Option<String>,
}

/// Fetch a Kaspa withdrawal by message_id
pub async fn handler(
    State(state): State<ServerState>,
    Query(query_params): Query<QueryParams>,
) -> ServerResult<ServerSuccessResponse<WithdrawalResponse>> {
    use hyperlane_core::H256;

    let message_id_str = query_params.message_id;

    tracing::debug!(%message_id_str, "Fetching Kaspa withdrawal by message_id");

    let db = &state.kaspa_db;

    // Parse message_id from hex string
    let message_id = match message_id_str.parse::<H256>() {
        Ok(id) => id,
        Err(e) => {
            tracing::error!(%message_id_str, error = ?e, "Invalid message_id format");
            return Err(ServerErrorResponse::new(
                StatusCode::BAD_REQUEST,
                ServerErrorBody {
                    message: format!("Invalid message_id format: {}", e),
                },
            ));
        }
    };

    // Retrieve the withdrawal message directly by message_id
    let message = match db
        .as_ref()
        .retrieve_kaspa_withdrawal_by_message_id(&message_id)
    {
        Ok(Some(message)) => message,
        Ok(None) => {
            return Err(ServerErrorResponse::new(
                StatusCode::NOT_FOUND,
                ServerErrorBody {
                    message: format!("No withdrawal found for message_id: {}", message_id_str),
                },
            ));
        }
        Err(e) => {
            tracing::error!(%message_id_str, error = ?e, "Error retrieving withdrawal from database");
            return Err(ServerErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ServerErrorBody {
                    message: format!("Database error: {}", e),
                },
            ));
        }
    };

    // Retrieve kaspa transaction ID if available
    let kaspa_tx = db
        .as_ref()
        .retrieve_withdrawal_kaspa_tx(&message_id)
        .unwrap_or(None);

    let response = WithdrawalResponse {
        message_id: format!("{:x}", message.id()),
        message,
        kaspa_tx,
    };

    Ok(ServerSuccessResponse::new(response))
}

use super::endpoints::*;
use axum::{
    body::Bytes,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::post,
    Router,
};
use dym_kas_core::deposit::DepositFXG;
use hyperlane_core::{Checkpoint, CheckpointWithMessageId, HyperlaneSignerExt, H256};
use std::sync::Arc;

use dym_kas_validator::deposit::validate_deposits;

pub struct AppError(eyre::Report);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        eprintln!("Error: {:?}", self.0);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "An internal error occurred".to_string(),
        )
            .into_response()
    }
}

/// docococ, http server shared state
pub type AppResult<T> = Result<T, AppError>;

#[derive(Clone)]
struct AppState<S: HyperlaneSignerExt + Send + Sync + 'static> {
    // TODO: needs to be shared across routers?
    signer: Arc<S>,
}

async fn respond_validate_new_deposits<S: HyperlaneSignerExt + Send + Sync + 'static>(
    State(state): State<Arc<AppState<S>>>,
    body: Bytes,
) -> AppResult<Json<String>> {
    let deposits: DepositFXG = body.try_into().map_err(|e: eyre::Report| AppError(e))?;

    if !validate_deposits(&deposits) {
        // Call to G()
        return Err(AppError(eyre::eyre!("Invalid deposit")));
    }

    let message_id = H256::random();
    let to_sign: CheckpointWithMessageId = CheckpointWithMessageId {
        checkpoint: Checkpoint {
            mailbox_domain: 1,
            merkle_tree_hook_address: H256::random(),
            root: H256::random(),
            index: 0,
        },
        message_id,
    };

    let sig = state
        .signer
        // .sign_checkpoint(to_sign)
        .sign(to_sign) // TODO: need to lock first?
        .await
        .map_err(|e| AppError(e.into()))?;
    let j =
        serde_json::to_string_pretty(&sig).map_err(|e: serde_json::Error| AppError(e.into()))?;

    Ok(Json(j))
}

pub fn router<S: HyperlaneSignerExt + Send + Sync + 'static>(signer: Arc<S>) -> Router {
    let state = Arc::new(AppState { signer });

    Router::new()
        .route(
            ROUTE_VALIDATE_NEW_DEPOSITS,
            post(respond_validate_new_deposits::<S>),
        )
        .with_state(state)
}

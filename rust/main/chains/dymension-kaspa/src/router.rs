use super::endpoints::*;
use async_trait::async_trait;
use axum::{
    body::Bytes,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::post,
    Router,
};
use dym_kas_core::deposit::DepositFXG;
use hyperlane_core::{
    ChainResult, Checkpoint, CheckpointWithMessageId, HyperlaneSignerExt, SignedType, H256,
};
use std::sync::Arc;

trait Signer: HyperlaneSignerExt + Send + Sync + 'static {}

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

pub type AppResult<T> = Result<T, AppError>;

#[derive(Clone)]
struct AppState<S: Signer> {
    signer: Arc<S>,
}

async fn validate_new_deposits<S: Signer>(
    State(state): State<Arc<AppState<S>>>,
    body: Bytes,
) -> AppResult<Json<String>> {
    let deposits: DepositFXG = body.try_into().map_err(|e: eyre::Report| AppError(e))?;

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
        .sign(to_sign)
        .await
        .map_err(|e| AppError(e.into()))?;
    let j =
        serde_json::to_string_pretty(&sig).map_err(|e: serde_json::Error| AppError(e.into()))?;

    Ok(Json(j))
}

pub fn router<S: Signer>(signer: Arc<S>) -> Router {
    let state = Arc::new(AppState { signer });

    Router::new()
        .route(
            ROUTE_VALIDATE_NEW_DEPOSITS,
            post(validate_new_deposits::<S>),
        )
        .with_state(state)
}

use super::endpoints::*;
use axum::{
    body::Bytes,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::post,
    Router,
};
use dym_kas_core::deposit::{DepositFXG, ConfirmationFXG};
use hyperlane_core::{Checkpoint, CheckpointWithMessageId, HyperlaneSignerExt, H256};
use std::sync::Arc;

use dym_kas_validator::deposit::{validate_deposits, validate_confirmed_withdrawals};

/// Signer here refers to the typical Hyperlane signer which will need to sign attestations to be able to relay TO the hub
pub fn router<S: HyperlaneSignerExt + Send + Sync + 'static>(signer: Arc<S>) -> Router {
    let state = Arc::new(HandlerState { signer });

    Router::new()
        .route(
            ROUTE_VALIDATE_NEW_DEPOSITS,
            post(respond_validate_new_deposits::<S>),
        )
        .route(
            ROUTE_VALIDATE_CONFIRMED_WITHDRAWALS,
            post(respond_validate_confirmed_withdrawals::<S>),
        )
        // TODO: add  other routes: respond to PSKT sign request, and confirmation attestion request
        .with_state(state)
}

async fn respond_validate_new_deposits<S: HyperlaneSignerExt + Send + Sync + 'static>(
    State(state): State<Arc<HandlerState<S>>>,
    body: Bytes,
) -> HandlerResult<Json<String>> {
    let deposits: DepositFXG = body.try_into().map_err(|e: eyre::Report| AppError(e))?;

    // Call to validator.G()
    if !validate_deposits(&deposits) {
        return Err(AppError(eyre::eyre!("Invalid deposit")));
    }

    let message_id = H256::random(); // TODO: extract from FXG
    let domain = 1; // TODO: extract from FXG

    let zero_array = [0u8; 32];
    let to_sign: CheckpointWithMessageId = CheckpointWithMessageId {
        checkpoint: Checkpoint {
            mailbox_domain: domain,
            merkle_tree_hook_address: H256::from_slice(&zero_array),
            root: H256::from_slice(&zero_array),
            index: 0,
        },
        message_id,
    };

    let sig = state
        .signer
        .sign(to_sign) // TODO: need to lock first?
        .await
        .map_err(|e| AppError(e.into()))?;

    let j =
        serde_json::to_string_pretty(&sig).map_err(|e: serde_json::Error| AppError(e.into()))?;

    Ok(Json(j))
}

async fn respond_validate_confirmed_withdrawals<S: HyperlaneSignerExt + Send + Sync + 'static>(
    State(state): State<Arc<HandlerState<S>>>,
    body: Bytes,
) -> HandlerResult<Json<String>> {
    let deposits: ConfirmationFXG = body.try_into().map_err(|e: eyre::Report| AppError(e))?;

    // Call to validator.G()
    if !validate_confirmed_withdrawals(&deposits) {
        return Err(AppError(eyre::eyre!("Invalid deposit")));
    }

    let message_id = H256::random(); // TODO: extract from FXG
    let domain = 1; // TODO: extract from FXG

    let zero_array = [0u8; 32];
    let to_sign: CheckpointWithMessageId = CheckpointWithMessageId {
        checkpoint: Checkpoint {
            mailbox_domain: domain,
            merkle_tree_hook_address: H256::from_slice(&zero_array),
            root: H256::from_slice(&zero_array),
            index: 0,
        },
        message_id,
    };

    let sig = state
        .signer
        .sign(to_sign) // TODO: need to lock first?
        .await
        .map_err(|e| AppError(e.into()))?;

    let j =
        serde_json::to_string_pretty(&sig).map_err(|e: serde_json::Error| AppError(e.into()))?;

    Ok(Json(j))
}

/// Allows automatic error mapping
struct AppError(eyre::Report);

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

/// Allows handler to have some state
type HandlerResult<T> = Result<T, AppError>;

#[derive(Clone)]
struct HandlerState<S: HyperlaneSignerExt + Send + Sync + 'static> {
    // TODO: needs to be shared across routers?
    signer: Arc<S>,
}

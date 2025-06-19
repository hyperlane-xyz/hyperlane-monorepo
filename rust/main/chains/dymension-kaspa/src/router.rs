use super::endpoints::*;
use async_trait::async_trait;
use axum::{
    body::Bytes,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use dym_kas_core::deposit::DepositFXG;
use hyperlane_core::CheckpointWithMessageId;
use hyperlane_core::{ChainResult, Checkpoint, SignedType, H256};
use std::sync::Arc;

pub struct AppError(eyre::Report);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        eprintln!("Error: {:?}", self.0); // Log the full error to the console

        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Something went wrong".to_string(),
        )
            .into_response()
    }
}

impl<E> From<E> for AppError
where
    E: Into<eyre::Report>,
{
    fn from(err: E) -> Self {
        Self(err.into())
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[async_trait]
pub trait Signer {
    async fn sign_checkpoint(
        &self,
        checkpoint: CheckpointWithMessageId,
    ) -> ChainResult<SignedType<CheckpointWithMessageId>>;
}

#[derive(Clone)]
struct ISMHandler<S: Signer> {
    signer: Arc<S>,
}

impl<S: Signer> ISMHandler<S> {
    /*
    What needs to happen
    1. Relayer has the vec<Deposit>
    2. Call F() to get FXG
    3. Call network to validator with FXG, and what's needed to produce a sig
    4. Call G(FXG) to check if to sign
    5. Possibly sign
    6. Return to relayer over network the digest
     */
    async fn validate_new_deposits(
        State(state): State<ISMHandler<S>>,
        body: Bytes,
        // ) -> impl IntoResponse {
    ) -> AppResult<String> {
        let deposits: DepositFXG = body.try_into()?; // TODO: use

        let message_id = H256::random(); // TODO: parse from request
        let to_sign: CheckpointWithMessageId = CheckpointWithMessageId {
            checkpoint: Checkpoint {
                mailbox_domain: 1,                        // TODO: populate
                merkle_tree_hook_address: H256::random(), // TODO: zero
                root: H256::random(),                     // TODO: zero
                index: 0,
            },
            message_id: message_id,
        }; // TODO: parse from request

        let sig = state.signer.sign_checkpoint(to_sign).await?;

        // let j = serde_json::to_string_pretty(&sig).map_err(|e| AppError(e.into()))?;
        let j = serde_json::to_string_pretty(&sig)?;
        Ok(j)

        // How are they bundled?
        // https://github.com/dymensionxyz/hyperlane-monorepo/blob/779828c92e48796ae9816fb9ccab23c9e56f82fb/rust/main/hyperlane-base/src/types/multisig.rs#L207

        // TODO: produce a digest sig
    }
}

// TODO: take some trait which can sign whats needed to sign
pub fn router<S: Signer>(handler: ISMHandler<S>) -> Router {
    Router::new().route(
        ROUTE_VALIDATE_NEW_DEPOSITS,
        post(ISMHandler::<S>::validate_new_deposits),
    )
    // .route(ROUTE_SIGN_PSKTS, post(sign_pskts))
    // .route(
    // ROUTE_VALIDATE_CONFIRMED_WITHDRAWALS,
    // post(validate_confirmed_withdrawals),
}

// async fn validate_new_deposits(body: Bytes) -> (StatusCode, Bytes) {}

// async fn sign_pskts(body: Bytes) -> (StatusCode, Bytes) {
//     unimplemented!()
// }

// async fn validate_confirmed_withdrawals(body: Bytes) -> (StatusCode, Bytes) {
//     unimplemented!()
// }

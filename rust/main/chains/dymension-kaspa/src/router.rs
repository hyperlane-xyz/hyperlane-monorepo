use super::endpoints::*;
use crate::deposit::validate_deposits;
use async_trait::async_trait;
use axum::{body::Bytes, http::StatusCode, routing::post, Router};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::post,
    Router,
};
use core::comms::endpoints::*;
use core::deposit::DepositFXG;
use dym_kas_validator::server_relayer::server::validate_new_deposits as validate_new_deposits_impl;
use hyperlane_core::CheckpointWithMessageId;
use hyperlane_core::{ChainResult, MerkleTreeHook, ReorgEvent, ReorgPeriod, SignedType};
use std::sync::Arc;

/*
What needs to happen
1. Relayer has the vec<Deposit>
2. Call F() to get FXG
3. Call network to validator with FXG, and what's needed to produce a sig
4. Call G(FXG) to check if to sign
5. Possibly sign
6. Return to relayer over network the digest
 */

// 1. The Signer trait (unchanged)
trait Signer: Send + Sync + 'static {
    // We'll have it sign a string slice for simplicity
    fn sign(&self, data: &str) -> String;
}

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
    async fn validate_new_deposits(
        State(state): State<ISMHandler<S>>,
        body: Bytes,
    ) -> impl IntoResponse {
        let deposits = body.try_into();
        match deposits {
            Ok(deposits) => Ok(validate_deposits(&deposits)),
            Err(e) => return Err(e),
        }

        let message_id = H256::random(); // TODO: parse from request
        let to_sign: CheckpointWithMessageId = CheckpointWithMessageId {
            checkpoint: Checkpoint {
                mailbox_domain: 1, // TODO: populate
            },
            message_id: message_id,
        }; // TODO: parse from request

        let sig = state.signer.sign_checkpoint(to_sign).await;

        // How are they bundled?
        // https://github.com/dymensionxyz/hyperlane-monorepo/blob/779828c92e48796ae9816fb9ccab23c9e56f82fb/rust/main/hyperlane-base/src/types/multisig.rs#L207

        // TODO: produce a digest sig
    }
}

// TODO: take some trait which can sign whats needed to sign
pub fn router<S: Signer>(handler: ISMHandler<S>) -> Router {
    Router::new().route(
        ROUTE_VALIDATE_NEW_DEPOSITS,
        post(ISMHandler::validate_new_deposits),
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

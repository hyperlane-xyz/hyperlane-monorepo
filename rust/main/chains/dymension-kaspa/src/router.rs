use crate::deposit::validate_deposits;
use axum::{body::Bytes, http::StatusCode, routing::post, Router};
use core::comms::endpoints::*;
use core::deposit::DepositFXG;
use dym_kas_validator::server_relayer::server::validate_new_deposits as validate_new_deposits_impl;

/*
What needs to happen
1. Relayer has the vec<Deposit>
2. Call F() to get FXG
3. Call network to validator with FXG, and what's needed to produce a sig
4. Call G(FXG) to check if to sign
5. Possibly sign
6. Return to relayer over network the digest
 */

pub fn router() -> Router {
    Router::new()
        .route(ROUTE_VALIDATE_NEW_DEPOSITS, post(validate_new_deposits))
        .route(ROUTE_SIGN_PSKTS, post(sign_pskts))
        .route(
            ROUTE_VALIDATE_CONFIRMED_WITHDRAWALS,
            post(validate_confirmed_withdrawals),
        )
}

async fn validate_new_deposits(body: Bytes) -> (StatusCode, Bytes) {
    let deposits = body.try_into();
    match deposits {
        Ok(deposits) => Ok(validate_deposits(&deposits)),
        Err(e) => return Err(e),
    }

    // TODO: produce a digest sig
}

async fn sign_pskts(body: Bytes) -> (StatusCode, Bytes) {
    unimplemented!()
}

async fn validate_confirmed_withdrawals(body: Bytes) -> (StatusCode, Bytes) {
    unimplemented!()
}

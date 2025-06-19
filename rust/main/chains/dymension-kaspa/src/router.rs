use crate::deposit::validate_deposits;
use axum::{body::Bytes, http::StatusCode, routing::post, Router};
use core::comms::endpoints::*;
use core::deposit::DepositFXG;
use dym_kas_validator::server_relayer::server::{validate_new_deposits as validate_new_deposits_impl};

async fn validate_new_deposits(body: Bytes) -> (StatusCode, Bytes) {
    let res = validate_new_deposits_impl(body).await;
    if Err(e) = res {
        return (StatusCode::BAD_REQUEST, 
    }

    // TODO: produce a digest sig
}

async fn sign_pskts(body: Bytes) -> (StatusCode, Bytes) {
    unimplemented!()
}

async fn validate_confirmed_withdrawals(body: Bytes) -> (StatusCode, Bytes) {
    unimplemented!()
}

pub fn router() -> Router {
    Router::new()
        .route(ROUTE_VALIDATE_NEW_DEPOSITS, post(validate_new_deposits))
        .route(ROUTE_SIGN_PSKTS, post(sign_pskts))
        .route(
            ROUTE_VALIDATE_CONFIRMED_WITHDRAWALS,
            post(validate_confirmed_withdrawals),
        )
}

use axum::{body::Bytes, http::StatusCode, routing::post, Router};
use core::comms::endpoints::*;

async fn validate_new_deposits(body: Bytes) -> StatusCode {
    StatusCode::OK
}

async fn sign_pskts(body: Bytes) -> (StatusCode, Bytes) {
    (StatusCode::OK, Bytes::new())
}

async fn validate_confirmed_withdrawals(body: Bytes) -> StatusCode {
    StatusCode::OK
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

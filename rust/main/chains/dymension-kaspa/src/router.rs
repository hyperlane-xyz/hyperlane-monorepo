use crate::deposit::validate_deposits;
use axum::{body::Bytes, http::StatusCode, routing::post, Router};
use core::comms::endpoints::*;
use core::deposit::DepositFXG;

async fn validate_new_deposits(body: Bytes) -> StatusCode {
    let deposits = body.try_into();
    match deposits {
        Ok(deposits) => {
            if !validate_deposits(&deposits) {
                return StatusCode::BAD_REQUEST
            }
            StatusCode::OK
        }
        Err(e) => {
            return StatusCode::BAD_REQUEST
        }
    }
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

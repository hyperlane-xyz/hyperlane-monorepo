use crate::deposit::validate_deposits;
use axum::{body::Bytes, http::StatusCode, routing::post, Router};
use core::deposit::DepositFXG;
use eyre::Error;

pub struct ConfirmedKaspaDeposit{
    message 
}


pub async fn validate_new_deposits(body: Bytes) -> Result<bool, Error> {
    let deposits = body.try_into();
    match deposits {
        Ok(deposits) => Ok(validate_deposits(&deposits)),
        Err(e) => return Err(e),
    }
}

pub async fn sign_pskts(body: Bytes) -> (StatusCode, Bytes) {
    unimplemented!()
}

pub async fn validate_confirmed_withdrawals(body: Bytes) -> bool {
    unimplemented!()
}

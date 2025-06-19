use bytes::Bytes;
use core::comms::endpoints::*;
use core::deposit::DepositFXG;
use eyre::Error;
use reqwest::{Client, StatusCode};

pub async fn validate_new_deposits(host: String, deposits: &DepositFXG) -> Result<bool, Error> {
    let bz = Bytes::from(deposits);
    let c = reqwest::Client::new();
    let res = c
        .post(format!("{}{}", host, ROUTE_VALIDATE_NEW_DEPOSITS))
        .body(bz)
        .send()
        .await?;
    let status = res.status();
    if status == StatusCode::OK {
        Ok(true)
    } else {
        Ok(false)
    }
}

struct PSKTRes;
struct PSKTFXG;

pub async fn sign_pskts(host: String, pskts: &PSKTFXG) -> Result<PSKTRes, Error> {
    unimplemented!()
}

struct WithdrawalFXG;

pub async fn validate_confirmed_withdrawals(
    host: String,
    withdrawals: &WithdrawalFXG,
) -> Result<bool, Error> {
    unimplemented!()
}

use core::deposit::DepositFXG;
use std::sync::Arc;

use eyre::Result;
use kaspa_wallet_core::prelude::DynRpcApi;

use crate::validate_deposit;

pub async fn validate_new_deposit(client: &Arc<DynRpcApi>, deposit: &DepositFXG) -> Result<bool> {
    let validation_result = validate_deposit(client, deposit).await?; 
    Ok(validation_result)
}
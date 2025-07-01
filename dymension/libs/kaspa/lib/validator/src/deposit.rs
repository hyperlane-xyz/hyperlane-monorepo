use core::deposit::DepositFXG;
use std::sync::Arc;

use crate::validate_deposit;
use eyre::Result;
use kaspa_addresses::Address;
use kaspa_wallet_core::prelude::DynRpcApi;

pub async fn validate_new_deposit(
    client: &Arc<DynRpcApi>,
    deposit: &DepositFXG,
    address: &Address,
) -> Result<bool> {
    let validation_result = validate_deposit(client, deposit, address).await?;
    Ok(validation_result)
}

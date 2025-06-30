use core::{confirmation::ConfirmationFXG, deposit::DepositFXG, withdraw::WithdrawFXG};

use eyre::Result;

pub async fn validate_deposits(fxg: &DepositFXG) -> Result<bool> {
    Ok(true)
}

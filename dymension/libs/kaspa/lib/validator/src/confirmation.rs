use core::{confirmation::ConfirmationFXG, deposit::DepositFXG, withdraw::WithdrawFXG};

use eyre::Result;

pub async fn validate_confirmed_withdrawals(fxg: &ConfirmationFXG) -> Result<bool> {
    Ok(true)
}

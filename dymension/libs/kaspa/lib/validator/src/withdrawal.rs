use corelib::{confirmation::ConfirmationFXG, deposit::DepositFXG, withdraw::WithdrawFXG};

use eyre::Result;

pub async fn validate_withdrawals(fxg: &WithdrawFXG) -> Result<bool> {
    Ok(true)
}

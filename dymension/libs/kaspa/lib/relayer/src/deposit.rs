use crate::handle_new_deposit;
use corelib::api::deposits::Deposit;
use corelib::deposit::DepositFXG;
use eyre::Result;

pub async fn on_new_deposit(escrow_address: &str, deposit: &Deposit) -> Result<Option<DepositFXG>> {
    let deposit_tx_result = handle_new_deposit(escrow_address, deposit).await?;
    Ok(Some(deposit_tx_result))
}

use crate::handle_new_deposit;
use corelib::api::deposits::Deposit;
use corelib::deposit::DepositFXG;
use eyre::Result;
use kaspa_addresses::Address;

pub async fn on_new_deposit(deposit: &Deposit, address: &Address) -> Result<Option<DepositFXG>> {
    let deposit_tx_result = handle_new_deposit(deposit, address).await?;
    Ok(Some(deposit_tx_result))
}

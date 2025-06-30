use std::error::Error;

use crate::handle_new_deposit;
use corelib::deposit::DepositFXG;
use eyre::Result;

pub async fn handle_new_deposits(
    transaction_ids: Vec<String>,
) -> Result<Vec<DepositFXG>, Box<dyn Error>> {
    let mut txs = Vec::new();

    for transaction in transaction_ids {
        let tx = handle_new_deposit(transaction).await?;
        txs.push(tx);
    }

    Ok(txs)
}

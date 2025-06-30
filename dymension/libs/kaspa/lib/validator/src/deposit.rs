use core::deposit::DepositFXG;
use std::error::Error;

use eyre::Result;
use kaspa_wrpc_client::KaspaRpcClient;

use crate::validate_deposit;

pub async fn validate_deposits(client: &KaspaRpcClient, deposits: Vec<DepositFXG>) -> Result<Vec<bool>, Box<dyn Error>> {

    let mut results: Vec<bool> = vec![];
    // iterate over all deposits and validate one by one
    for deposit in deposits {
        let result = validate_deposit(client,deposit).await?;
        results.push(result);
    }
    Ok(results)
}
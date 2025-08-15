use eyre::Result;
use kaspa_addresses::Address;
use kaspa_core::info;
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_wallet_core::error::Error;
use kaspa_wallet_core::prelude::*;
use std::sync::Arc;

pub async fn check_balance<T: RpcApi + ?Sized>(
    source: &str,
    rpc: &T,
    addr: &Address,
) -> Result<u64, Error> {
    let utxos = rpc
        .get_utxos_by_addresses(vec![addr.clone()])
        .await
        .map_err(|e| Error::Custom(format!("Getting UTXOs for address: {e}")))?;

    let num = utxos.len();
    let balance: u64 = utxos.into_iter().map(|u| u.utxo_entry.amount).sum();

    info!("{} has {} UTXOs and {} balance", source, num, balance);

    Ok(balance)
}

// TODO: needed?
pub async fn check_balance_wallet(w: Arc<Wallet>) -> Result<(), Error> {
    let a = w.account()?;
    for _ in 0..10 {
        if a.balance().is_some() {
            break;
        }
        workflow_core::task::sleep(std::time::Duration::from_millis(200)).await;
    }

    if let Some(b) = a.balance() {
        info!("Wallet account balance:");
        info!("  Mature:   {} KAS", sompi_to_kaspa_string(b.mature));
        info!("  Pending:  {} KAS", sompi_to_kaspa_string(b.pending));
        info!("  Outgoing: {} KAS", sompi_to_kaspa_string(b.outgoing));
    } else {
        info!("Wallet account has no balance or is still syncing.");
    }

    Ok(())
}

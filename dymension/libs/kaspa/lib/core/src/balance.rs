use eyre::Result;
use kaspa_addresses::Address;
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_wallet_core::error::Error;
use kaspa_wallet_core::prelude::*;
use std::sync::Arc;
use tracing::info;

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

    info!(
        source = source,
        utxo_count = num,
        balance = balance,
        "kaspa: checked balance"
    );

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
        let mature_str = sompi_to_kaspa_string(b.mature);
        let pending_str = sompi_to_kaspa_string(b.pending);
        let outgoing_str = sompi_to_kaspa_string(b.outgoing);
        info!(
            mature_kas = %mature_str,
            pending_kas = %pending_str,
            outgoing_kas = %outgoing_str,
            "kaspa: wallet account balance"
        );
    } else {
        info!("kaspa: wallet account has no balance or is still syncing");
    }

    Ok(())
}

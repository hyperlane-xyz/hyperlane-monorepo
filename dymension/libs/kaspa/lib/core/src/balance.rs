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

#![allow(unused)] // TODO: remove

use kaspa_consensus_core::network::NetworkId;
use kaspa_core::info;
use kaspa_wallet_core::api::WalletApi;
use kaspa_wallet_core::error::Error;
use kaspa_wallet_core::wallet::Wallet;
use kaspa_wallet_keys::secret::Secret;

use kaspa_wallet_core::prelude::*; // Import the prelude for easy access to traits/structs

use std::sync::Arc;

use kaspa_wrpc_client::Resolver;

pub async fn get_wallet(
    s: &Secret,
    network_id: NetworkId,
    url: String,
) -> Result<Arc<Wallet>, Error> {
    let w = Arc::new(Wallet::try_new(
        Wallet::local_store()?,
        Some(Resolver::default()),
        Some(network_id),
    )?);

    // Start background services (UTXO processor, event handling).
    w.start().await?;

    w.clone().connect(Some(url), &network_id).await?;

    let is_c = w.is_connected();
    info!("connected: {:?}", is_c);

    w.clone().wallet_open(s.clone(), None, true, false).await?;

    let accounts = w.clone().accounts_enumerate().await?;
    let account_descriptor = accounts.get(0).ok_or("Wallet has no accounts.")?;
    let account_id = account_descriptor.account_id;
    info!(
        "Account ID: {:?}, recv addr: {:?}, change addr: {:?}",
        account_id, account_descriptor.receive_address, account_descriptor.change_address
    );

    w.clone().accounts_select(Some(account_id)).await?;
    w.clone().accounts_activate(Some(vec![account_id])).await?;

    Ok(w)
}

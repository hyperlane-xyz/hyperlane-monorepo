use anyhow::Result;
use hyperlane_core::HyperlaneMessage;
use kaspa_consensus_core::network::NetworkId;
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_wallet_core::account::Account;
use kaspa_wallet_pskt::prelude::Bundle;
use kaspa_wallet_pskt::prelude::*;
use std::sync::Arc;
// Assuming EscrowPublic is correctly defined in the `core` crate
// and `core` is a dependency in this crate's Cargo.toml (e.g., `core = { path = "../core" }`)
use core::escrow::EscrowPublic;
use core::withdraw::WithdrawFXG;

/// Updated signature matching the specification
pub async fn on_new_withdrawals(
    messages: Vec<HyperlaneMessage>,
    kaspa_rpc: &impl RpcApi,
    escrow_public: EscrowPublic,
    relayer_kaspa_account: Arc<dyn Account>, // TODO: make generic..?
    network_id: NetworkId,
    // and cosmos provider
) -> Result<Option<WithdrawFXG>> {
    // TODO: impl
    let v: Vec<PSKT<Signer>> = vec![];
    let fxg = WithdrawFXG::new(Bundle::from(v));
    Ok(Some(fxg))
}

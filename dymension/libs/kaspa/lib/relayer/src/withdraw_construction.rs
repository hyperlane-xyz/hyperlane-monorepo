use core::escrow::EscrowPublic;
use core::wallet::EasyKaspaWallet;
use core::withdraw::WithdrawFXG;
use eyre::Result;
use hyperlane_core::HyperlaneMessage;
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_wallet_pskt::prelude::Bundle;
use kaspa_wallet_pskt::prelude::*;

use crate::build_withdrawal_pskts;

pub async fn on_new_withdrawals(
    messages: Vec<HyperlaneMessage>,
    relayer: EasyKaspaWallet,
    cosmos: CosmosGrpcClient,
    escrow_public: EscrowPublic,
    hub_height: Option<u32>,
) -> Result<Option<WithdrawFXG>> {
    let pskt = build_withdrawal_pskts(
        messages,
        hub_height,
        &cosmos,
        &relayer.api(),
        &escrow_public,
        &relayer.account(),
        relayer.network_id(),
    )
    .await
    .map_err(|e| eyre::eyre!("Build withdrawal PSKT: {}", e))?;

    match pskt {
        None => Ok(None), // nothing to process
        Some(pskt) => Ok(Some(WithdrawFXG::new(Bundle::from(pskt)))),
    }
}

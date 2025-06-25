use core::escrow::EscrowPublic;
use core::wallet::EasyKaspaWallet;
use core::withdraw::WithdrawFXG;
use eyre::Result;
use hyperlane_core::HyperlaneMessage;
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use kaspa_wallet_pskt::prelude::Bundle;
use kaspa_wallet_pskt::prelude::*;

pub async fn on_new_withdrawals(
    messages: Vec<HyperlaneMessage>,
    w: EasyKaspaWallet,
    cosmos: CosmosGrpcClient,
    escrow_public: EscrowPublic,
) -> Result<Option<WithdrawFXG>> {
    // TODO: impl
    let v: Vec<PSKT<Signer>> = vec![];
    let fxg = WithdrawFXG::new(Bundle::from(v));
    Ok(Some(fxg))
}

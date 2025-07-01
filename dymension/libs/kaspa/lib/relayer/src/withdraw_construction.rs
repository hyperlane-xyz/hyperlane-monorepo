use crate::hub_to_kaspa::build_withdrawal_pskt;
use corelib::escrow::EscrowPublic;
use corelib::wallet::EasyKaspaWallet;
use corelib::withdraw::WithdrawFXG;
use eyre::Result;
use hyperlane_core::{Decode, HyperlaneMessage};
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use hyperlane_warp_route::TokenMessage;
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_wallet_pskt::prelude::Bundle;
use std::io::Cursor;

/// Processes given messages and returns WithdrawFXG and the very first outpoint
/// (the one preceding all the given transfers; it should be used during process indication).
pub async fn on_new_withdrawals(
    messages: Vec<HyperlaneMessage>,
    relayer: EasyKaspaWallet,
    cosmos: CosmosGrpcClient,
    escrow_public: EscrowPublic,
    hub_height: Option<u32>,
) -> Result<Option<(WithdrawFXG, TransactionOutpoint)>> {
    let (outpoint, pending_messages) =
        crate::hub_to_kaspa::get_pending_withdrawals(messages, &cosmos, hub_height)
            .await
            .map_err(|e| eyre::eyre!("Get pending withdrawals: {}", e))?;

    let withdrawal_details: Vec<_> = pending_messages
        .into_iter()
        .filter_map(|m| {
            match TokenMessage::read_from(&mut Cursor::new(&m.body)) {
                Ok(msg) => {
                    let kaspa_recipient = kaspa_addresses::Address::new(
                        relayer.network_info.address_prefix,
                        kaspa_addresses::Version::PubKey, // should always be PubKey
                        m.recipient.as_bytes(),
                    );

                    Some(crate::hub_to_kaspa::WithdrawalDetails {
                        message_id: m.id(),
                        recipient: kaspa_recipient,
                        amount_sompi: msg.amount().as_u64(),
                    })
                }
                Err(e) => None, // TODO: log?
            }
        })
        .collect();

    if withdrawal_details.is_empty() {
        return Ok(None); // nothing to process
    }

    let pskt = build_withdrawal_pskt(
        withdrawal_details,
        &relayer.api(),
        &escrow_public,
        &relayer.account(),
        &outpoint,
        relayer.network_info.network_id,
    )
    .await
    .map_err(|e| eyre::eyre!("Build withdrawal PSKT: {}", e))?;

    Ok(Some((WithdrawFXG::new(Bundle::from(pskt)), outpoint)))
}

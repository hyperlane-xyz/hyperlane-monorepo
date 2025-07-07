use eyre::Result;

use super::hub_to_kaspa::build_withdrawal_pskt;
use base64;
use corelib::escrow::EscrowPublic;
use corelib::wallet::EasyKaspaWallet;
use corelib::withdraw::{filter_pending_withdrawals, WithdrawFXG};
use hardcode::tx::DUST_AMOUNT;
use hex::ToHex;
use hyperlane_core::{Decode, HyperlaneMessage, H256};
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{WithdrawalId, WithdrawalStatus};
use hyperlane_warp_route::TokenMessage;
use kaspa_addresses::Prefix;
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_hashes;
use kaspa_wallet_core::prelude::*;
use kaspa_wallet_pskt::prelude::Bundle;
use kaspa_wallet_pskt::prelude::*;
use std::io::Cursor;
use tracing::info;

pub fn get_recipient_address(recipient: H256, prefix: Prefix) -> kaspa_addresses::Address {
    let addr = kaspa_addresses::Address::new(
        prefix,
        kaspa_addresses::Version::PubKey, // should always be PubKey
        recipient.as_bytes(),
    );
    addr
}

/// Processes given messages and returns WithdrawFXG and the very first outpoint
/// (the one preceding all the given transfers; it should be used during process indication).
pub async fn on_new_withdrawals(
    messages: Vec<HyperlaneMessage>,
    relayer: EasyKaspaWallet,
    cosmos: CosmosGrpcClient,
    escrow_public: EscrowPublic,
    hub_height: Option<u32>,
) -> Result<Option<(WithdrawFXG, TransactionOutpoint)>> {
    info!("Kaspa relayer, getting pending withdrawals");
    let (outpoint, pending_messages) = filter_pending_withdrawals(messages, &cosmos, hub_height)
        .await
        .map_err(|e| eyre::eyre!("Get pending withdrawals: {}", e))?;
    info!("Kaspa relayer, got pending withdrawals");

    let withdrawal_details: Vec<_> = pending_messages
        .iter()
        .filter_map(
            |m| match TokenMessage::read_from(&mut Cursor::new(&m.body)) {
                Ok(msg) => {
                    let kaspa_recipient =
                        get_recipient_address(m.recipient, relayer.network_info.address_prefix);

                    if msg.amount().as_u64() < DUST_AMOUNT {
                        info!(
                            "Kaspa relayer, withdrawal amount is less than dust amount, skipping"
                        );
                        return None;
                    }

                    Some(WithdrawalDetails {
                        message_id: m.id(),
                        recipient: kaspa_recipient,
                        amount_sompi: msg.amount().as_u64(),
                    })
                }
                Err(e) => {
                    info!("Kaspa relayer, failed to read TokenMessage: {}", e);
                    None
                }
            },
        )
        .collect();

    if withdrawal_details.is_empty() {
        info!("Kaspa relayer, no pending withdrawals, all in batch are already processed and confirmed on hub");
        return Ok(None); // nothing to process
    }
    info!(
        "Kaspa relayer, got pending withdrawals, building PSKT, len: {}",
        withdrawal_details.len()
    );

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

    // We have a bundle with one PSKT which covers all the HL messages.
    Ok(Some((
        WithdrawFXG::new(Bundle::from(pskt), vec![pending_messages]),
        outpoint,
    )))
}

/// Details of a withdrawal extracted from HyperlaneMessage
#[derive(Debug, Clone)]
pub struct WithdrawalDetails {
    pub message_id: H256,
    pub recipient: kaspa_addresses::Address,
    pub amount_sompi: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use kaspa_hashes::Hash;

    #[test]
    fn test_transaction_id_conversion() {
        // Test with valid 32-byte transaction ID
        let b64 = "Xhz2eE568YCGdKJS60F9j6ADE1GQ3UFHyvmNhGOn5zo=";
        let bytes = STANDARD.decode(b64).unwrap();
        let bz = bytes.as_slice().try_into().unwrap();
        let kaspa_tx_id = kaspa_hashes::Hash::from_bytes(bz);
        println!("kaspa_tx_id: {:?}", kaspa_tx_id);
    }
}

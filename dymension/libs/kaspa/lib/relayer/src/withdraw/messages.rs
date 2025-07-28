use super::hub_to_kaspa::{build_withdrawal_pskt, fetch_input_utxos, filter_outputs_from_msgs};
use corelib::escrow::EscrowPublic;
use corelib::payload::MessageIDs;
use corelib::wallet::EasyKaspaWallet;
use corelib::withdraw::{filter_pending_withdrawals, WithdrawFXG};
use eyre::Result;
use hyperlane_core::HyperlaneMessage;
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_wallet_pskt::prelude::Bundle;
use tracing::info;

/// Processes given messages and returns WithdrawFXG and the very first outpoint
/// (the one preceding all the given transfers; it should be used during process indication).
pub async fn on_new_withdrawals(
    messages: Vec<HyperlaneMessage>,
    relayer: EasyKaspaWallet,
    cosmos: CosmosGrpcClient,
    escrow_public: EscrowPublic,
    hub_height: Option<u32>,
) -> Result<Option<WithdrawFXG>> {
    info!("Kaspa relayer, getting pending withdrawals");
    let (current_anchor, pending_msgs) = filter_pending_withdrawals(messages, &cosmos, hub_height)
        .await
        .map_err(|e| eyre::eyre!("Get pending withdrawals: {}", e))?;
    info!("Kaspa relayer, got pending withdrawals");

    let (valid_msgs, outputs) = filter_outputs_from_msgs(pending_msgs, relayer.net.address_prefix);

    if outputs.is_empty() {
        info!("Kaspa relayer, no pending withdrawals, all in batch are already processed and confirmed on hub");
        return Ok(None); // nothing to process
    }
    info!(
        "Kaspa relayer, got pending withdrawals, building PSKT, len: {}",
        outputs.len()
    );

    let relayer_address = relayer.account().change_address()?;

    let inputs = fetch_input_utxos(
        &relayer.api(),
        &escrow_public,
        &relayer_address,
        &current_anchor,
        relayer.net.network_id,
    )
    .await
    .map_err(|e| eyre::eyre!("Fetch input UTXOs: {}", e))?;

    let payload = MessageIDs::from(&valid_msgs).to_bytes();

    let pskt = build_withdrawal_pskt(
        inputs,
        outputs,
        payload,
        &escrow_public,
        &relayer_address,
        relayer.net.network_id,
    )
    .map_err(|e| eyre::eyre!("Build withdrawal PSKT: {}", e))?;

    let new_anchor = TransactionOutpoint::new(pskt.calculate_id(), (pskt.outputs.len() - 1) as u32);

    // We have a bundle with one PSKT which covers all the HL messages.
    Ok(Some(WithdrawFXG::new(
        Bundle::from(pskt),
        vec![valid_msgs],
        vec![current_anchor, new_anchor],
    )))
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

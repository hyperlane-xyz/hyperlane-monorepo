use super::hub_to_kaspa::{
    build_withdrawal_pskt, extract_current_anchor, fetch_input_utxos, get_normal_bucket_feerate,
    get_outputs_from_msgs_with_mass_limit,
};
use crate::withdraw::sweep::{create_inputs_from_sweeping_bundle, create_sweeping_bundle};
use corelib::consts::RELAYER_SIG_OP_COUNT;
use corelib::escrow::{self, EscrowPublic};
use corelib::payload::MessageIDs;
use corelib::wallet::EasyKaspaWallet;
use corelib::withdraw::{filter_pending_withdrawals, WithdrawFXG};
use eyre::Result;
use hardcode::tx::SWEEPING_THRESHOLD;
use hyperlane_core::HyperlaneMessage;
use hyperlane_core::U256;
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use kaspa_consensus_core::tx::{TransactionInput, TransactionOutpoint, UtxoEntry};
use kaspa_wallet_pskt::bundle::Bundle;
use tracing::info;

// (input, entry, optional_redeem_script)
pub(crate) type PopulatedInput = (TransactionInput, UtxoEntry, Option<Vec<u8>>);

/// Processes given messages and returns WithdrawFXG and the very first outpoint
/// (the one preceding all the given transfers; it should be used during process indication).
pub async fn on_new_withdrawals(
    messages: Vec<HyperlaneMessage>,
    relayer: EasyKaspaWallet,
    cosmos: CosmosGrpcClient,
    escrow_public: EscrowPublic,
    min_deposit_sompi: U256,
) -> Result<Option<WithdrawFXG>> {
    info!("Kaspa relayer, getting pending withdrawals");

    let (current_anchor, pending_msgs) = filter_pending_withdrawals(messages, &cosmos)
        .await
        .map_err(|e| eyre::eyre!("Get pending withdrawals: {}", e))?;

    info!("Kaspa relayer, got pending withdrawals");

    build_withdrawal_fxg(
        pending_msgs,
        current_anchor,
        relayer,
        escrow_public,
        min_deposit_sompi,
    )
    .await
}

pub async fn build_withdrawal_fxg(
    pending_msgs: Vec<HyperlaneMessage>,
    current_anchor: TransactionOutpoint,
    relayer: EasyKaspaWallet,
    escrow_public: EscrowPublic,
    min_deposit_sompi: U256,
) -> Result<Option<WithdrawFXG>> {
    // Get sample inputs for mass estimation
    let escrow_inputs = fetch_input_utxos(
        &relayer.api(),
        &escrow_public.addr,
        Some(escrow_public.redeem_script.clone()),
        escrow_public.n() as u8,
        relayer.net.network_id,
    )
    .await
    .map_err(|e| eyre::eyre!("Fetch sample escrow UTXOs for mass estimation: {}", e))?;
    
    // Filter out dust messages and create Kaspa outputs with mass limit
    let (valid_msgs, outputs) = get_outputs_from_msgs_with_mass_limit(
        pending_msgs,
        relayer.net.address_prefix,
        min_deposit_sompi,
        escrow_inputs.clone(),
        relayer.net.network_id,
        escrow_public.m() as u16,
    );

    let feerate = get_normal_bucket_feerate(&relayer.api())
        .await
        .map_err(|e| eyre::eyre!("Get normal bucket feerate: {e}"))?;

    if outputs.is_empty() {
        info!("Kaspa relayer, no valid pending withdrawals, all in batch are already processed and confirmed on hub");
        return Ok(None); // nothing to process
    }
    info!(
        "Kaspa relayer, got pending withdrawals, building PSKT, withdrawal num: {}",
        outputs.len()
    );

    let relayer_address = relayer.account().change_address()?;
    let relayer_inputs = fetch_input_utxos(
        &relayer.api(),
        &relayer_address,
        None,
        RELAYER_SIG_OP_COUNT,
        relayer.net.network_id,
    )
    .await
    .map_err(|e| eyre::eyre!("Fetch relayer UTXOs: {}", e))?;

    let (sweeping_bundle, inputs) = if escrow_inputs.len() > SWEEPING_THRESHOLD {
        // Sweep

        // Extract the current anchor from the escrow UTXO set.
        // All (and only) non-anchor UTXOs will be swept.
        // Anchor UTXO will be used as the input for withdrawal PSKT.
        let (anchor_input, escrow_inputs_to_sweep) =
            extract_current_anchor(current_anchor, escrow_inputs)
                .map_err(|e| eyre::eyre!("Extract current anchor: {}", e))?;

        let to_sweep_num = escrow_inputs_to_sweep.len();

        let sweeping_bundle = create_sweeping_bundle(
            &relayer,
            &escrow_public,
            escrow_inputs_to_sweep,
            relayer_inputs,
        )
        .await
        .map_err(|e| eyre::eyre!("Create sweeping bundle: {}", e))?;

        // Use sweeping bundle's outputs to create inputs for withdrawal PSKT.
        // Outputs contain escrow and relayer change.
        let swept_outputs = create_inputs_from_sweeping_bundle(&sweeping_bundle, &escrow_public)
            .map_err(|e| eyre::eyre!("Create input from sweeping bundle: {}", e))?;

        info!(
            "Constructed sweeping bundle of {} PSKTs, {to_sweep_num} escrow inputs are swept",
            sweeping_bundle.0.len(),
        );

        let mut inputs = Vec::with_capacity(swept_outputs.len() + 1);
        inputs.push(anchor_input);
        inputs.extend(swept_outputs); // use the swept outputs for the withdrawal inputs

        (Some(sweeping_bundle), inputs)
    } else {
        info!("No sweep needed, continue to withdrawal");

        let mut inputs = Vec::with_capacity(escrow_inputs.len() + relayer_inputs.len());
        inputs.extend(escrow_inputs);
        inputs.extend(relayer_inputs);

        (None, inputs)
    };

    let payload = MessageIDs::from(&valid_msgs).to_bytes();

    let pskt = build_withdrawal_pskt(
        inputs,
        outputs,
        payload,
        &escrow_public,
        &relayer_address,
        relayer.net.network_id,
        min_deposit_sompi,
        feerate,
    )
    .map_err(|e| eyre::eyre!("Build withdrawal PSKT: {}", e))?;

    // Contract: the last output of the withdrawal PSKT is the new anchor
    let new_anchor = TransactionOutpoint::new(pskt.calculate_id(), (pskt.outputs.len() - 1) as u32);

    // The first N (if any) elements are empty since sweeping PSKTs don't have any HL messages.
    // The last element is the withdrawal PSKT, so it should have all the HL messages.
    let messages = {
        let sweep_count = sweeping_bundle.as_ref().map_or(0, |b| b.0.len());
        let mut messages = Vec::with_capacity(sweep_count + valid_msgs.len());
        messages.extend(vec![Vec::new(); sweep_count]);
        messages.push(valid_msgs);
        messages
    };

    // Create a final bundle. It has the following structure:
    // 1. Sweeping bundle (if any) – might contain multiple PSKTs. It sweeps all non-anchor UTXOs.
    // 2. One withdrawal PSKT – contains the output UTXO from the sweeping bundle and the anchor input
    let bundle = match sweeping_bundle {
        Some(mut bundle) => {
            bundle.add_pskt(pskt);
            bundle
        }
        None => Bundle::from(pskt),
    };

    Ok(Some(WithdrawFXG::new(
        bundle,
        messages,
        vec![current_anchor, new_anchor],
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use hyperlane_core::Decode;
    use hyperlane_warp_route::TokenMessage;
    use kaspa_hashes::Hash;
    use kaspa_wallet_core::tx::{Generator, GeneratorSettings};
    use std::io::Cursor;

    #[test]
    fn test_transaction_id_conversion() {
        // Test with valid 32-byte transaction ID
        let b64 = "Xhz2eE568YCGdKJS60F9j6ADE1GQ3UFHyvmNhGOn5zo=";
        let bytes = STANDARD.decode(b64).unwrap();
        let bz = bytes.as_slice().try_into().unwrap();
        let kaspa_tx_id = kaspa_hashes::Hash::from_bytes(bz);
        println!("kaspa_tx_id: {:?}", kaspa_tx_id);
    }

    #[test]
    fn test_decode_token_message() {
        let bytes_a: Vec<Vec<u8>> = vec![
            vec![
                223, 45, 201, 23, 84, 12, 115, 128, 168, 110, 81, 250, 212, 184, 225, 16, 26, 14,
                250, 39, 71, 58, 92, 169, 185, 124, 235, 132, 108, 196, 2, 171, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 49, 45, 2,
            ],
            vec![
                188, 255, 117, 135, 245, 116, 226, 73, 181, 73, 50, 146, 145, 35, 150, 130, 214,
                211, 72, 28, 203, 197, 153, 124, 121, 119, 10, 96, 122, 179, 236, 152, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 119, 53,
                148, 0,
            ],
            vec![
                188, 255, 117, 135, 245, 116, 226, 73, 181, 73, 50, 146, 145, 35, 150, 130, 214,
                211, 72, 28, 203, 197, 153, 124, 121, 119, 10, 96, 122, 179, 236, 152, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 59, 154,
                202, 0,
            ],
            vec![
                188, 255, 117, 135, 245, 116, 226, 73, 181, 73, 50, 146, 145, 35, 150, 130, 214,
                211, 72, 28, 203, 197, 153, 124, 121, 119, 10, 96, 122, 179, 236, 152, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 84, 11,
                228, 0,
            ],
            vec![
                188, 255, 117, 135, 245, 116, 226, 73, 181, 73, 50, 146, 145, 35, 150, 130, 214,
                211, 72, 28, 203, 197, 153, 124, 121, 119, 10, 96, 122, 179, 236, 152, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 131, 33,
                86, 0,
            ],
        ];

        for (i, bytes) in bytes_a.iter().enumerate() {
            // Create a Cursor around the byte array for the reader
            let mut reader = Cursor::new(bytes);

            // Decode the byte array into a TokenMessage
            let token_message =
                TokenMessage::read_from(&mut reader).expect("Failed to decode TokenMessage");
        }
    }
}

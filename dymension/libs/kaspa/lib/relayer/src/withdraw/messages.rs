use super::hub_to_kaspa::{
    build_withdrawal_pskt, extract_current_anchor, fetch_input_utxos, get_normal_bucket_feerate,
    get_outputs_from_msgs,
};
use crate::withdraw::sweep::{create_inputs_from_sweeping_bundle, create_sweeping_bundle};
use corelib::consts::RELAYER_SIG_OP_COUNT;
use corelib::escrow::EscrowPublic;
use corelib::payload::MessageIDs;
use corelib::wallet::EasyKaspaWallet;
use corelib::withdraw::{filter_pending_withdrawals, WithdrawFXG};
use eyre::Result;
use hardcode::tx::{MAX_MASS_MARGIN, SWEEPING_THRESHOLD};
use hyperlane_core::HyperlaneMessage;
use hyperlane_core::U256;
use hyperlane_cosmos::{native::ModuleQueryClient, CosmosProvider};
use kaspa_consensus_core::tx::{TransactionInput, TransactionOutpoint, UtxoEntry};
use kaspa_wallet_pskt::bundle::Bundle;
use tracing::{error, info};

// (input, entry, optional_redeem_script)
pub(crate) type PopulatedInput = (TransactionInput, UtxoEntry, Option<Vec<u8>>);

/// Adjusts outputs and messages to fit within available funds from swept inputs
/// Returns (adjusted_outputs, adjusted_messages)
fn adjust_outputs_for_available_funds_swept(
    inputs: &[PopulatedInput],
    mut outputs: Vec<kaspa_consensus_core::tx::TransactionOutput>,
    mut messages: Vec<HyperlaneMessage>,
) -> Result<(
    Vec<kaspa_consensus_core::tx::TransactionOutput>,
    Vec<HyperlaneMessage>,
)> {
    // Calculate total available funds from escrow inputs only (excluding relayer inputs)
    let total_available: u64 = inputs
        .iter()
        .filter(|(_, _, redeem_script)| redeem_script.is_some()) // escrow inputs have redeem script
        .map(|(_, entry, _)| entry.amount)
        .sum();

    let mut total_requested: u64 = outputs.iter().map(|o| o.value).sum();

    if total_requested <= total_available {
        return Ok((outputs, messages));
    }

    // Remove outputs until total fits within available funds
    while total_requested > total_available && !outputs.is_empty() {
        let removed_output = outputs.pop();
        messages.pop();
        if let Some(out) = removed_output {
            total_requested -= out.value;
        }
    }

    if outputs.is_empty() {
        return Err(eyre::eyre!(
            "Cannot process any withdrawals - available funds ({} sompi) insufficient even for smallest withdrawal",
            total_available
        ));
    }

    Ok((outputs, messages))
}

/// Adjusts outputs and messages to fit within transaction mass limits
/// Returns (adjusted_outputs, adjusted_messages, final_mass)
fn adjust_outputs_for_mass_limit(
    inputs: Vec<PopulatedInput>,
    mut outputs: Vec<kaspa_consensus_core::tx::TransactionOutput>,
    mut messages: Vec<HyperlaneMessage>,
    network_id: kaspa_consensus_core::network::NetworkId,
    escrow_m: u16,
) -> Result<(
    Vec<kaspa_consensus_core::tx::TransactionOutput>,
    Vec<HyperlaneMessage>,
    u64,
)> {
    // Use MAX_MASS_MARGIN as safety margin for mass limit
    // This ensures we stay under the limit even with estimation variance
    let max_allowed_mass =
        (kaspa_wallet_core::tx::MAXIMUM_STANDARD_TRANSACTION_MASS as f64 * MAX_MASS_MARGIN) as u64;
    loop {
        let tx_mass = super::hub_to_kaspa::estimate_mass(
            inputs.clone(),
            outputs.clone(),
            MessageIDs::from(&messages).to_bytes(),
            network_id,
            escrow_m,
        )
        .map_err(|e| eyre::eyre!("Estimate TX mass: {e}"))?;
        if tx_mass <= max_allowed_mass {
            return Ok((outputs, messages, tx_mass));
        }
        if outputs.is_empty() {
            return Err(eyre::eyre!(
                "Cannot process any withdrawals - even a single withdrawal exceeds mass limit"
            ));
        }
        outputs.pop();
        messages.pop();
    }
}

/// Processes given messages and returns WithdrawFXG and the very first outpoint
/// (the one preceding all the given transfers; it should be used during process indication).
pub async fn on_new_withdrawals(
    messages: Vec<HyperlaneMessage>,
    relayer: EasyKaspaWallet,
    cosmos: CosmosProvider<ModuleQueryClient>,
    escrow_public: EscrowPublic,
    min_withdrawal_sompi: U256,
    tx_fee_multiplier: f64,
    max_sweep_inputs: Option<usize>,
    max_sweep_bundle_bytes: usize,
) -> Result<Option<WithdrawFXG>> {
    let (current_anchor, pending_msgs) = filter_pending_withdrawals(messages, cosmos.query())
        .await
        .map_err(|e| eyre::eyre!("Get pending withdrawals: {}", e))?;

    info!("kaspa relayer: filtered pending withdrawals");

    build_withdrawal_fxg(
        pending_msgs,
        current_anchor,
        relayer,
        escrow_public,
        min_withdrawal_sompi,
        tx_fee_multiplier,
        max_sweep_inputs,
        max_sweep_bundle_bytes,
    )
    .await
}

pub async fn build_withdrawal_fxg(
    pending_msgs: Vec<HyperlaneMessage>,
    current_anchor: TransactionOutpoint,
    relayer: EasyKaspaWallet,
    escrow_public: EscrowPublic,
    min_withdrawal_sompi: U256,
    tx_fee_multiplier: f64,
    max_sweep_inputs: Option<usize>,
    max_sweep_bundle_bytes: usize,
) -> Result<Option<WithdrawFXG>> {
    // Filter out dust messages and create Kaspa outputs for the rest
    let (valid_msgs, outputs) = get_outputs_from_msgs(
        pending_msgs,
        relayer.net.address_prefix,
        min_withdrawal_sompi,
    );

    if outputs.is_empty() {
        info!("kaspa relayer: no valid pending withdrawals found, all in batch already processed and confirmed on hub");
        return Ok(None); // nothing to process
    }

    // Get all the UTXOs for the escrow and the relayer
    let escrow_inputs = fetch_input_utxos(
        &relayer.api(),
        &escrow_public.addr,
        Some(escrow_public.redeem_script.clone()),
        escrow_public.n() as u8,
        relayer.net.network_id,
    )
    .await
    .map_err(|e| eyre::eyre!("Fetch escrow UTXOs: {}", e))?;

    // Get relayer change address for the withdrawal PSKT change output
    let relayer_address = relayer.account().change_address()?;

    // Fetch relayer UTXOs from change address
    let relayer_inputs = fetch_input_utxos(
        &relayer.api(),
        &relayer_address,
        None,
        RELAYER_SIG_OP_COUNT,
        relayer.net.network_id,
    )
    .await
    .map_err(|e| eyre::eyre!("Fetch relayer change address UTXOs: {}", e))?;

    // Early validation of relayer funds available (otherwise it will panic later during PSKT building)
    if relayer_inputs.is_empty() {
        error!(
            "Relayer has no UTXOs available. Cannot process withdrawals without relayer funds to pay transaction fees. \
            Please fund relayer address. All withdrawal operations will be marked as failed and retried later."
        );
        return Ok(None);
    }

    let (sweeping_bundle, inputs, adjusted_outputs, adjusted_msgs) = if escrow_inputs.len()
        > SWEEPING_THRESHOLD
    {
        // Sweep

        // Extract the current anchor from the escrow UTXO set.
        // All (and only) non-anchor UTXOs will be swept.
        // Anchor UTXO will be used as the input for withdrawal PSKT.
        let (anchor_input, escrow_inputs_to_sweep) =
            extract_current_anchor(current_anchor, escrow_inputs)
                .map_err(|e| eyre::eyre!("Extract current anchor: {}", e))?;

        let to_sweep_num = escrow_inputs_to_sweep.len();

        // Calculate total withdrawal amount needed
        let total_withdrawal_amount: u64 = outputs.iter().map(|o| o.value).sum();

        // Get anchor amount (not swept but available for withdrawals)
        let anchor_amount = anchor_input.1.amount; // anchor_input is (TransactionInput, UtxoEntry, Option<Vec<u8>>)

        let sweeping_bundle = create_sweeping_bundle(
            &relayer,
            &escrow_public,
            escrow_inputs_to_sweep,
            relayer_inputs,
            total_withdrawal_amount,
            anchor_amount,
            max_sweep_inputs,
            max_sweep_bundle_bytes,
        )
        .await
        .map_err(|e| eyre::eyre!("Create sweeping bundle: {}", e))?;

        // Use sweeping bundle's outputs to create inputs for withdrawal PSKT.
        // Outputs contain escrow and relayer change.
        let swept_outputs = create_inputs_from_sweeping_bundle(&sweeping_bundle, &escrow_public)
            .map_err(|e| eyre::eyre!("Create input from sweeping bundle: {}", e))?;

        info!(
            pskt_count = sweeping_bundle.0.len(),
            escrow_inputs_swept = to_sweep_num,
            "kaspa relayer: constructed sweeping bundle"
        );

        let mut inputs = Vec::with_capacity(swept_outputs.len() + 1);
        inputs.push(anchor_input);
        inputs.extend(swept_outputs); // use the swept outputs for the withdrawal inputs

        // Adjust outputs to fit within swept funds before checking mass limits
        let (adjusted_outputs, adjusted_msgs) =
            adjust_outputs_for_available_funds_swept(&inputs, outputs, valid_msgs)?;

        (
            Some(sweeping_bundle),
            inputs,
            adjusted_outputs,
            adjusted_msgs,
        )
    } else {
        info!("kaspa relayer: no sweep needed, continuing to withdrawal");

        let mut inputs = Vec::with_capacity(escrow_inputs.len() + relayer_inputs.len());
        inputs.extend(escrow_inputs);
        inputs.extend(relayer_inputs);

        (None, inputs, outputs, valid_msgs)
    };

    // Estimate mass and remove outputs if necessary
    let (final_outputs, final_msgs, tx_mass) = adjust_outputs_for_mass_limit(
        inputs.clone(),
        adjusted_outputs,
        adjusted_msgs,
        relayer.net.network_id,
        escrow_public.m() as u16,
    )?;

    let payload = MessageIDs::from(&final_msgs).to_bytes();

    let feerate = get_normal_bucket_feerate(&relayer.api())
        .await
        .map_err(|e| eyre::eyre!("Get normal bucket feerate: {e}"))?;

    let pskt = build_withdrawal_pskt(
        inputs,
        final_outputs.clone(),
        payload,
        &escrow_public,
        &relayer_address,
        min_withdrawal_sompi,
        feerate * tx_fee_multiplier,
        tx_mass,
    )
    .map_err(|e| eyre::eyre!("Build withdrawal PSKT: {}", e))?;

    info!(
        withdrawal_count = final_outputs.len(),
        "kaspa relayer: built withdrawal PSKT"
    );

    // Contract: the last output of the withdrawal PSKT is the new anchor
    let new_anchor = TransactionOutpoint::new(pskt.calculate_id(), (pskt.outputs.len() - 1) as u32);

    let messages = {
        // Create a list of (list of) messages for teach TX
        // The first N (if any) elements are empty since sweeping PSKTs don't have any HL messages.
        // The last element is the withdrawal PSKT, so it should have all the HL messages.
        let sweep_count = sweeping_bundle.as_ref().map_or(0, |b| b.0.len());
        let mut messages = Vec::with_capacity(sweep_count + final_msgs.len());
        messages.extend(vec![Vec::new(); sweep_count]);
        messages.push(final_msgs);
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
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use hyperlane_core::Decode;
    use hyperlane_warp_route::TokenMessage;

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

        for (_i, bytes) in bytes_a.iter().enumerate() {
            // Create a Cursor around the byte array for the reader
            let mut reader = Cursor::new(bytes);

            // Decode the byte array into a TokenMessage
            let _token_message =
                TokenMessage::read_from(&mut reader).expect("Failed to decode TokenMessage");
        }
    }
}

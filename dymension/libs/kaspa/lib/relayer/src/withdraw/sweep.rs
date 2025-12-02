use crate::withdraw::messages::PopulatedInput;
use crate::withdraw::populated_input::PopulatedInputBuilder;
use corelib::consts::RELAYER_SIG_OP_COUNT;
use corelib::escrow::EscrowPublic;
use corelib::util::input_sighash_type;
use corelib::wallet::EasyKaspaWallet;
use eyre::{eyre, Result};
use hardcode::tx::{DUST_AMOUNT, RELAYER_SWEEPING_PRIORITY_FEE};
use kaspa_consensus_client::{
    TransactionOutpoint as ClientTransactionOutpoint, UtxoEntry as ClientUtxoEntry,
};

use super::hub_to_kaspa::estimate_mass;
use kaspa_consensus_core::network::NetworkId;
use kaspa_consensus_core::tx::TransactionOutput;
use kaspa_txscript::standard::pay_to_address_script;
use kaspa_wallet_core::tx::MAXIMUM_STANDARD_TRANSACTION_MASS;
use kaspa_wallet_core::utxo::UtxoEntryReference;
use kaspa_wallet_pskt::bundle::Bundle;
use kaspa_wallet_pskt::prelude::{Creator, OutputBuilder, Signer, PSKT};
use kaspa_wallet_pskt::pskt::InputBuilder;
use tracing::info;

/// Helper function to create test outputs for mass estimation
fn create_test_outputs(
    escrow_balance: u64,
    relayer_balance: u64,
    escrow: &EscrowPublic,
    relayer_address: &kaspa_addresses::Address,
) -> Result<Vec<TransactionOutput>> {
    if escrow_balance == 0 {
        return Err(eyre!("escrow_balance cannot be zero"));
    }
    if relayer_balance == 0 {
        return Err(eyre!("relayer_balance cannot be zero"));
    }
    Ok(vec![
        TransactionOutput {
            value: escrow_balance,
            script_public_key: escrow.p2sh.clone(),
        },
        TransactionOutput {
            value: relayer_balance,
            script_public_key: pay_to_address_script(relayer_address),
        },
    ])
}

/// Calculate the maximum number of escrow inputs when sweeping that fit within mass limit using binary search
fn calculate_sweep_size(
    escrow_inputs: &[PopulatedInput],
    relayer_inputs: &[PopulatedInput],
    escrow: &EscrowPublic,
    relayer_address: &kaspa_addresses::Address,
    network_id: NetworkId,
) -> Result<usize> {
    let total_relayer_balance = relayer_inputs.iter().map(|(_, e, _)| e.amount).sum::<u64>();

    // First try all escrow inputs
    let total_escrow_balance = escrow_inputs.iter().map(|(_, e, _)| e.amount).sum::<u64>();

    let test_outputs = create_test_outputs(
        total_escrow_balance,
        total_relayer_balance,
        escrow,
        relayer_address,
    )?;

    let all_inputs: Vec<_> = escrow_inputs
        .iter()
        .cloned()
        .chain(relayer_inputs.iter().cloned())
        .collect();

    match estimate_mass(
        all_inputs,
        test_outputs,
        vec![],
        network_id,
        escrow.m() as u16,
    ) {
        Ok(mass) if mass <= MAXIMUM_STANDARD_TRANSACTION_MASS => {
            info!(
                escrow_inputs_count = escrow_inputs.len(),
                mass = mass,
                "kaspa relayer sweeping: all escrow inputs fit within mass limit"
            );
            return Ok(escrow_inputs.len());
        }
        Ok(mass) => {
            info!(
                mass = mass,
                "kaspa relayer sweeping: all inputs exceed mass limit, starting binary search"
            );
        }
        Err(e) => {
            info!(
                error = %e,
                "kaspa relayer sweeping: mass calculation failed, starting binary search"
            );
        }
    }

    // Binary search for maximum batch size
    let mut low = 1;
    let mut high = escrow_inputs.len();
    let mut best_size = 1;

    while low <= high {
        let mid = (low + high) / 2;
        let test_escrow_batch = escrow_inputs.iter().take(mid).cloned().collect::<Vec<_>>();
        let test_escrow_balance = test_escrow_batch
            .iter()
            .map(|(_, e, _)| e.amount)
            .sum::<u64>();

        let test_outputs = create_test_outputs(
            test_escrow_balance,
            total_relayer_balance,
            escrow,
            relayer_address,
        )?;

        let test_inputs: Vec<_> = test_escrow_batch
            .into_iter()
            .chain(relayer_inputs.iter().cloned())
            .collect();

        match estimate_mass(
            test_inputs,
            test_outputs,
            vec![],
            network_id,
            escrow.m() as u16,
        ) {
            Ok(mass) if mass <= MAXIMUM_STANDARD_TRANSACTION_MASS => {
                best_size = mid;
                low = mid + 1;
                info!(
                    batch_size = mid,
                    mass = mass,
                    "kaspa relayer sweeping: batch size fits within mass limit"
                );
            }
            Ok(mass) => {
                high = mid - 1;
                info!(
                    batch_size = mid,
                    mass = mass,
                    "kaspa relayer sweeping: batch size exceeds mass limit"
                );
            }
            Err(e) => {
                high = mid - 1;
                info!(batch_size = mid, error = %e, "kaspa relayer sweeping: mass calculation failed for batch size");
            }
        }
    }

    if best_size == 0 {
        return Err(eyre!(
            "Cannot create valid PSKT: even single escrow input exceeds mass limit"
        ));
    }

    info!(
        best_size = best_size,
        "kaspa relayer sweeping: determined optimal batch size"
    );
    Ok(best_size)
}

/// Calculate the relayer fee for a sweeping transaction
/// Returns (estimated_fee, relayer_output_amount)
fn calculate_relayer_fee(
    batch_escrow_inputs: &[PopulatedInput],
    relayer_inputs: &[PopulatedInput],
    batch_escrow_balance: u64,
    escrow: &EscrowPublic,
    relayer_address: &kaspa_addresses::Address,
    network_id: NetworkId,
    feerate: f64,
) -> Result<(u64, u64)> {
    let total_relayer_balance = relayer_inputs.iter().map(|(_, e, _)| e.amount).sum::<u64>();

    // Initial mass calculation with total relayer balance as output
    let initial_outputs = create_test_outputs(
        batch_escrow_balance,
        total_relayer_balance,
        escrow,
        relayer_address,
    )?;

    let all_inputs: Vec<_> = batch_escrow_inputs
        .iter()
        .cloned()
        .chain(relayer_inputs.iter().cloned())
        .collect();

    let initial_mass = estimate_mass(
        all_inputs.clone(),
        initial_outputs,
        vec![],
        network_id,
        escrow.m() as u16,
    )?;

    // Calculate initial fee estimate
    let initial_fee = (initial_mass as f64 * feerate).ceil() as u64 + RELAYER_SWEEPING_PRIORITY_FEE;

    // Second pass: recalculate mass with more accurate output (balance - fee)
    let estimated_relayer_output = total_relayer_balance.saturating_sub(initial_fee);

    let final_outputs = create_test_outputs(
        batch_escrow_balance,
        estimated_relayer_output,
        escrow,
        relayer_address,
    )?;

    let mass = estimate_mass(
        all_inputs,
        final_outputs,
        vec![],
        network_id,
        escrow.m() as u16,
    )?;

    let estimated_fee = (mass as f64 * feerate).ceil() as u64 + RELAYER_SWEEPING_PRIORITY_FEE;

    // Check if relayer has enough balance to cover fees and minimum dust output
    if total_relayer_balance < estimated_fee + DUST_AMOUNT {
        return Err(eyre!(
            "Insufficient relayer balance: have {} sompi, need {} (fee) + {} (dust) = {} sompi",
            total_relayer_balance,
            estimated_fee,
            DUST_AMOUNT,
            estimated_fee + DUST_AMOUNT
        ));
    }

    let relayer_output_amount = total_relayer_balance - estimated_fee;

    Ok((estimated_fee, relayer_output_amount))
}

/// Creates inputs for the next PSKT iteration by using outputs from the current PSKT.
/// Returns updated relayer and escrow inputs for chaining.
fn prepare_next_iteration_inputs(
    pskt_signer: &PSKT<Signer>,
    escrow: &EscrowPublic,
    mut escrow_inputs: Vec<PopulatedInput>,
) -> Result<(Vec<PopulatedInput>, Vec<PopulatedInput>)> {
    // Get the actual transaction ID and output details from the PSKT
    let sweep_tx = PSKT::<Signer>::from(pskt_signer.clone());
    let tx_id = sweep_tx.calculate_id();

    // Find both escrow and relayer outputs
    // TODO: DRY out snippet with similar thing in create_inputs_from_sweeping_bundle
    let (relayer_idx, relayer_output, escrow_idx, escrow_output) = match sweep_tx.outputs.as_slice()
    {
        [o0, o1] if o0.script_public_key == escrow.p2sh => (1u32, o1, 0u32, o0),
        [o0, o1] if o1.script_public_key == escrow.p2sh => (0u32, o0, 1u32, o1),
        _ => {
            return Err(eyre!(
                "PSKT must have exactly two outputs: escrow and relayer"
            ))
        }
    };

    // Create relayer input from previous PSKT's relayer output
    let relayer_input = PopulatedInputBuilder::new(
        tx_id,
        relayer_idx,
        relayer_output.amount,
        relayer_output.script_public_key.clone(),
    )
    .build();

    // Create escrow input from previous PSKT's escrow output
    let escrow_input = PopulatedInputBuilder::new(
        tx_id,
        escrow_idx,
        escrow_output.amount,
        escrow_output.script_public_key.clone(),
    )
    .sig_op_count(escrow.n() as u8)
    .redeem_script(Some(escrow.redeem_script.clone()))
    .build();
    // Next iteration will use both outputs as inputs
    let new_relayer_inputs = vec![relayer_input];
    // Add the escrow output from previous PSKT to the beginning of remaining escrow inputs
    escrow_inputs.insert(0, escrow_input);

    info!(
        escrow_idx = escrow_idx,
        escrow_amount = escrow_output.amount,
        relayer_idx = relayer_idx,
        relayer_amount = relayer_output.amount,
        "kaspa relayer sweeping: chained escrow and relayer outputs for next batch"
    );

    Ok((new_relayer_inputs, escrow_inputs))
}

/// Create a bundle that sweeps funds in the escrow address.
/// The function expects a set of inputs that are needed to be swept – [`escrow_inputs`].
/// And a set of relayer inputs to cover the transaction fee – [`relayer_inputs`].
/// Creates multiple PSKTs to respect mass limits.
/// Each PSKT includes all relayer inputs and consolidates escrow inputs.
/// Each PSKT has exactly 2 outputs: consolidated escrow and relayer change.
/// Sweeping will stop when enough inputs are consolidated to cover withdrawal amount and MAX_SWEEP_INPUTS is also reached, even if more inputs are available.
///
/// # Parameters
/// * `anchor_amount` - The amount available in the anchor UTXO that will be used for withdrawals (not swept)
/// * `max_sweep_inputs` - Optional maximum number of inputs to sweep (if None, only bundle size limit applies)
/// * `max_sweep_bundle_bytes` - Maximum bundle size in bytes (to fit within validator body limit)
pub async fn create_sweeping_bundle(
    relayer_wallet: &EasyKaspaWallet,
    escrow: &EscrowPublic,
    mut escrow_inputs: Vec<PopulatedInput>,
    mut relayer_inputs: Vec<PopulatedInput>,
    total_withdrawal_amount: u64,
    anchor_amount: u64,
    max_sweep_inputs: Option<usize>,
    max_sweep_bundle_bytes: usize,
) -> Result<Bundle> {
    use kaspa_txscript::standard::pay_to_address_script;

    if escrow_inputs.is_empty() {
        return Err(eyre!("No escrow inputs to sweep"));
    }

    // Sort escrow inputs by amount (largest first) for more efficient consolidation
    escrow_inputs.sort_by(|a, b| b.1.amount.cmp(&a.1.amount));

    let relayer_address = relayer_wallet.account().change_address()?;
    let feerate = relayer_wallet
        .api()
        .get_fee_estimate()
        .await?
        .normal_buckets
        .first()
        .unwrap()
        .feerate;

    let mut bundle = Bundle::new();

    info!(
        escrow_inputs_count = escrow_inputs.len(),
        relayer_inputs_count = relayer_inputs.len(),
        total_withdrawal_amount = total_withdrawal_amount,
        anchor_amount = anchor_amount,
        "kaspa relayer sweeping: started"
    );

    let mut total_swept_amount = 0u64;
    let mut total_inputs_swept = 0usize;

    // Calculate how much more we need to sweep considering the anchor amount
    let withdrawal_amount_without_anchor = total_withdrawal_amount.saturating_sub(anchor_amount);
    info!(
        amount_to_sweep = withdrawal_amount_without_anchor,
        total_withdrawals = total_withdrawal_amount,
        anchor_amount = anchor_amount,
        "kaspa relayer sweeping: calculated amount to sweep (sompi)"
    );
    // Process escrow inputs recursively until:
    // 1. All are consumed, OR
    // 2. Reached the maximum bundle size (always enforced), OR
    // 3. Reached the maximum number of inputs (if configured)
    while !escrow_inputs.is_empty() {
        // Check input count limit if configured
        if let Some(max_inputs) = max_sweep_inputs {
            if total_inputs_swept >= max_inputs {
                info!(
                    total_swept_amount = total_swept_amount,
                    total_inputs_swept = total_inputs_swept,
                    max_inputs = max_inputs,
                    remaining_escrow_inputs = escrow_inputs.len(),
                    "kaspa relayer sweeping: stopped at configured max_sweep_inputs limit"
                );
                break;
            }
        }
        // Find batch size that fits within mass limit
        let batch_size = calculate_sweep_size(
            &escrow_inputs,
            &relayer_inputs,
            escrow,
            &relayer_address,
            relayer_wallet.net.network_id,
        )?;

        // Take batch of escrow inputs
        let batch_escrow_inputs: Vec<_> = escrow_inputs.drain(0..batch_size).collect();
        let batch_escrow_balance = batch_escrow_inputs
            .iter()
            .map(|(_, e, _)| e.amount)
            .sum::<u64>();
        let batch_escrow_inputs_count = batch_escrow_inputs.len();
        total_swept_amount += batch_escrow_balance;
        total_inputs_swept += batch_escrow_inputs_count;

        // Calculate relayer fee and output amount
        let (estimated_fee, relayer_output_amount) = calculate_relayer_fee(
            &batch_escrow_inputs,
            &relayer_inputs,
            batch_escrow_balance,
            escrow,
            &relayer_address,
            relayer_wallet.net.network_id,
            feerate,
        )?;

        // Create PSKT
        let mut pskt = PSKT::<Creator>::default().constructor();

        // Add escrow inputs
        for (input, entry, _) in batch_escrow_inputs {
            let mut b = InputBuilder::default();
            b.previous_outpoint(input.previous_outpoint)
                .sig_op_count(escrow.n() as u8)
                .sighash_type(input_sighash_type())
                .redeem_script(escrow.redeem_script.clone())
                .utxo_entry(entry);

            pskt = pskt.input(b.build().map_err(|e| eyre!("Build escrow input: {}", e))?);
        }

        // Add all relayer inputs
        for (input, entry, _) in &relayer_inputs {
            let mut b = InputBuilder::default();
            b.previous_outpoint(input.previous_outpoint)
                .sig_op_count(RELAYER_SIG_OP_COUNT)
                .sighash_type(input_sighash_type())
                .utxo_entry(entry.clone());

            pskt = pskt.input(b.build().map_err(|e| eyre!("Build relayer input: {}", e))?);
        }

        // Add escrow output
        let escrow_output_builder = OutputBuilder::default()
            .amount(batch_escrow_balance)
            .script_public_key(escrow.p2sh.clone())
            .build()
            .map_err(|e| eyre!("Build escrow output: {}", e))?;

        pskt = pskt.output(escrow_output_builder);

        // Add relayer output
        let relayer_output_builder = OutputBuilder::default()
            .amount(relayer_output_amount)
            .script_public_key(pay_to_address_script(&relayer_address))
            .build()
            .map_err(|e| eyre!("Build relayer output: {}", e))?;

        pskt = pskt.output(relayer_output_builder);

        let pskt_signer = pskt.no_more_inputs().no_more_outputs().signer();
        let pskt_id = pskt_signer.calculate_id();

        // Update inputs for next iteration (use outputs from current PSKT as inputs)
        if !escrow_inputs.is_empty() {
            let (new_relayer_inputs, updated_escrow_inputs) =
                prepare_next_iteration_inputs(&pskt_signer, escrow, escrow_inputs)?;
            relayer_inputs = new_relayer_inputs;
            escrow_inputs = updated_escrow_inputs;
        }

        bundle.add_pskt(pskt_signer);

        // Check bundle size limit
        let bundle_bytes = bundle
            .serialize()
            .map_err(|e| eyre!("Serialize bundle to check size: {}", e))?;
        let bundle_size = bundle_bytes.len();

        if bundle_size >= max_sweep_bundle_bytes {
            info!(
                bundle_size_bytes = bundle_size,
                max_bundle_bytes = max_sweep_bundle_bytes,
                pskts_count = bundle.0.len(),
                "kaspa relayer sweeping: reached max bundle size limit, stopping"
            );
            break;
        }

        info!(
            pskt_id = %pskt_id,
            batch_escrow_inputs_count = batch_escrow_inputs_count,
            estimated_fee = estimated_fee,
            relayer_output_amount = relayer_output_amount,
            bundle_size_bytes = bundle_size,
            "kaspa relayer sweeping: created PSKT"
        );
    }
    info!(
        pskts_count = bundle.0.len(),
        inputs_swept = total_inputs_swept,
        swept_amount = total_swept_amount,
        total_available = anchor_amount + total_swept_amount,
        total_withdrawals = total_withdrawal_amount,
        "kaspa relayer sweeping: completed"
    );
    Ok(bundle)
}

pub fn create_inputs_from_sweeping_bundle(
    sweeping_bundle: &Bundle,
    escrow: &EscrowPublic,
) -> Result<Vec<PopulatedInput>> {
    let last_pskt = sweeping_bundle
        .iter()
        .last()
        .cloned()
        .ok_or_else(|| eyre!("Empty sweeping bundle"))?;

    let sweep_tx = PSKT::<Signer>::from(last_pskt);
    let tx_id = sweep_tx.calculate_id();

    // Expect exactly two outputs: {escrow, relayer} in some order.
    let (relayer_idx, relayer_output, escrow_idx, escrow_output) = match sweep_tx.outputs.as_slice() {
        [o0, o1] if o0.script_public_key == escrow.p2sh => (1u32, o1, 0u32, o0),
        [o0, o1] if o1.script_public_key == escrow.p2sh => (0u32, o0, 1u32, o1),
        _ => {
            return Err(eyre!(
                "Resulting sweeping TX must have exactly two outputs: swept escrow UTXO and relayer change"
            ))
        }
    };

    let relayer_input = PopulatedInputBuilder::new(
        tx_id,
        relayer_idx,
        relayer_output.amount,
        relayer_output.script_public_key.clone(),
    )
    .build();

    let escrow_input =
        PopulatedInputBuilder::new(tx_id, escrow_idx, escrow_output.amount, escrow.p2sh.clone())
            .sig_op_count(escrow.n() as u8)
            .redeem_script(Some(escrow.redeem_script.clone()))
            .build();

    Ok(vec![relayer_input, escrow_input])
}

pub fn utxo_reference_from_populated_input(
    (input, entry, _redeem_script): PopulatedInput,
) -> UtxoEntryReference {
    UtxoEntryReference::from(ClientUtxoEntry {
        address: None,
        outpoint: ClientTransactionOutpoint::from(input.previous_outpoint),
        amount: entry.amount,
        script_public_key: entry.script_public_key.clone(),
        block_daa_score: entry.block_daa_score,
        is_coinbase: entry.is_coinbase,
    })
}

use crate::withdraw::messages::PopulatedInput;
use corelib::consts::RELAYER_SIG_OP_COUNT;
use corelib::escrow::EscrowPublic;
use corelib::util::input_sighash_type;
use corelib::wallet::EasyKaspaWallet;
use eyre::{eyre, Result};
use hardcode::tx::{DUST_AMOUNT, MAX_SWEEP_INPUTS, RELAYER_SWEEPING_PRIORITY_FEE};
use kaspa_consensus_client::{
    TransactionOutpoint as ClientTransactionOutpoint, UtxoEntry as ClientUtxoEntry,
};

use kaspa_txscript::standard::pay_to_address_script;
use kaspa_wallet_core::tx::MAXIMUM_STANDARD_TRANSACTION_MASS;
use kaspa_consensus_core::network::NetworkId;
use kaspa_consensus_core::constants::UNACCEPTED_DAA_SCORE;
use kaspa_consensus_core::tx::{TransactionInput, TransactionOutpoint, TransactionOutput, UtxoEntry};
use kaspa_wallet_core::utxo::UtxoEntryReference;
use kaspa_wallet_pskt::bundle::Bundle;
use kaspa_wallet_pskt::prelude::{Creator, OutputBuilder, Signer, PSKT};
use kaspa_wallet_pskt::pskt::InputBuilder;
use super::hub_to_kaspa::estimate_mass;
use tracing::info;

/// Calculate the maximum number of escrow inputs when sweeping that fit within mass limit using binary search
fn calculate_sweep_size(
    escrow_inputs: &[PopulatedInput],
    relayer_inputs: &[PopulatedInput],
    escrow: &EscrowPublic,
    relayer_address: &kaspa_addresses::Address,
    network_id: NetworkId,
) -> Result<usize> {

    if escrow_inputs.is_empty() {
        return Ok(0);
    }
    
    let total_relayer_balance = relayer_inputs.iter().map(|(_, e, _)| e.amount).sum::<u64>();
    
    // First try all escrow inputs
    let total_escrow_balance = escrow_inputs.iter().map(|(_, e, _)| e.amount).sum::<u64>();
    
    let test_outputs = vec![
        TransactionOutput {
            value: total_escrow_balance,
            script_public_key: escrow.p2sh.clone(),
        },
        TransactionOutput {
            value: total_relayer_balance,
            script_public_key: pay_to_address_script(relayer_address),
        },
    ];
    
    let all_inputs: Vec<_> = escrow_inputs.iter().cloned()
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
            info!("Kaspa sweeping: all {} escrow inputs fit (mass: {})", escrow_inputs.len(), mass);
            return Ok(escrow_inputs.len());
        }
        Ok(mass) => {
            info!("Kaspa sweeping: all inputs exceed mass limit ({}), starting binary search", mass);
        }
        Err(e) => {
            info!("Kaspa sweeping: mass calculation failed: {}, starting binary search", e);
        }
    }
    
    // Binary search for maximum batch size
    let mut low = 1;
    let mut high = escrow_inputs.len();
    let mut best_size = 1;
    
    while low <= high {
        let mid = (low + high) / 2;
        let test_escrow_batch = escrow_inputs.iter().take(mid).cloned().collect::<Vec<_>>();
        let test_escrow_balance = test_escrow_batch.iter().map(|(_, e, _)| e.amount).sum::<u64>();
        
        let test_outputs = vec![
            TransactionOutput {
                value: test_escrow_balance,
                script_public_key: escrow.p2sh.clone(),
            },
            TransactionOutput {
                value: total_relayer_balance,
                script_public_key: pay_to_address_script(relayer_address),
            },
        ];
        
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
                info!("Kaspa sweeping: batch size {} works (mass: {})", mid, mass);
            }
            Ok(mass) => {
                high = mid - 1;
                info!("Kaspa sweeping: batch size {} too large (mass: {})", mid, mass);
            }
            Err(e) => {
                high = mid - 1;
                info!("Kaspa sweeping: batch size {} failed: {}", mid, e);
            }
        }
    }
    
    if best_size == 0 {
        return Err(eyre!("Cannot create valid PSKT: even single escrow input exceeds mass limit"));
    }
    
    info!("Kaspa sweeping: optimal batch size: {}", best_size);
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
    let initial_outputs = vec![
        TransactionOutput {
            value: batch_escrow_balance,
            script_public_key: escrow.p2sh.clone(),
        },
        TransactionOutput {
            value: total_relayer_balance,
            script_public_key: pay_to_address_script(relayer_address),
        },
    ];
    
    let all_inputs: Vec<_> = batch_escrow_inputs.iter().cloned()
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
    
    let final_outputs = vec![
        TransactionOutput {
            value: batch_escrow_balance,
            script_public_key: escrow.p2sh.clone(),
        },
        TransactionOutput {
            value: estimated_relayer_output,
            script_public_key: pay_to_address_script(relayer_address),
        },
    ];
    
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
            total_relayer_balance, estimated_fee, DUST_AMOUNT, estimated_fee + DUST_AMOUNT
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
    let (relayer_idx, relayer_output, escrow_idx, escrow_output) = match sweep_tx.outputs.as_slice() {
        [o0, o1] if o0.script_public_key == escrow.p2sh => (1u32, o1, 0u32, o0),
        [o0, o1] if o1.script_public_key == escrow.p2sh => (0u32, o0, 1u32, o1),
        _ => return Err(eyre!("PSKT must have exactly two outputs: escrow and relayer")),
    };
    
    // Create relayer input from previous PSKT's relayer output
    let relayer_input = (
        TransactionInput::new(
            TransactionOutpoint::new(tx_id, relayer_idx),
            vec![],
            u64::MAX,
            RELAYER_SIG_OP_COUNT,
        ),
        UtxoEntry::new(
            relayer_output.amount,
            relayer_output.script_public_key.clone(),
            UNACCEPTED_DAA_SCORE,
            false,
        ),
        None,
    );
    
    // Create escrow input from previous PSKT's escrow output
    let escrow_input = (
        TransactionInput::new(
            TransactionOutpoint::new(tx_id, escrow_idx),
            vec![],
            u64::MAX,
            escrow.n() as u8,
        ),
        UtxoEntry::new(
            escrow_output.amount,
            escrow_output.script_public_key.clone(),
            UNACCEPTED_DAA_SCORE,
            false,
        ),
        Some(escrow.redeem_script.clone()),
    );
    
    // Next iteration will use both outputs as inputs
    let new_relayer_inputs = vec![relayer_input];
    // Add the escrow output from previous PSKT to the beginning of remaining escrow inputs
    escrow_inputs.insert(0, escrow_input);
    
    info!("Kaspa sweeping: chaining escrow output {} ({} sompi) and relayer output {} ({} sompi) for next batch", 
          escrow_idx, escrow_output.amount, relayer_idx, relayer_output.amount);
    
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
pub async fn create_sweeping_bundle(
    relayer_wallet: &EasyKaspaWallet,
    escrow: &EscrowPublic,
    mut escrow_inputs: Vec<PopulatedInput>,
    mut relayer_inputs: Vec<PopulatedInput>,
    total_withdrawal_amount: u64,
    anchor_amount: u64,
) -> Result<Bundle> {

    use kaspa_txscript::standard::pay_to_address_script;
    
    if escrow_inputs.is_empty() {
        return Err(eyre!("No escrow inputs to sweep"));
    }
    
    let relayer_address = relayer_wallet.account().change_address()?;
    let feerate = relayer_wallet.api().get_fee_estimate().await?
        .normal_buckets.first().unwrap().feerate;
    
    let mut bundle = Bundle::new();
    
    info!(
        "Kaspa sweeping: starting with {} escrow inputs, {} relayer inputs, need {} sompi for withdrawals (anchor has {} sompi)",
        escrow_inputs.len(), relayer_inputs.len(), total_withdrawal_amount, anchor_amount
    );
    
    // Track total swept amount and number of inputs processed
    let mut total_swept_amount = 0u64;
    let mut total_inputs_swept = 0usize;
    
    // Calculate how much more we need to sweep considering the anchor amount
    let effective_withdrawal_amount = if anchor_amount >= total_withdrawal_amount {
        0 // Anchor already covers all withdrawals, no need to sweep for withdrawal amount
    } else {
        total_withdrawal_amount - anchor_amount
    };
    
    info!(
        "Kaspa sweeping: need to sweep {} sompi (total withdrawals {} sompi - anchor {} sompi)",
        effective_withdrawal_amount, total_withdrawal_amount, anchor_amount
    );
    
    // Process escrow inputs recursively until:
    // 1. All are consumed, OR
    // 2. We have enough for withdrawals AND reached the maximum number of inputs (1000)
    while !escrow_inputs.is_empty() {
        // Check if we've swept enough to cover withdrawals AND reached the maximum inputs
        if total_swept_amount >= effective_withdrawal_amount && total_inputs_swept >= MAX_SWEEP_INPUTS {
            info!(
                "Kaspa sweeping: stopping - swept {} sompi (covers effective withdrawal amount of {} sompi) and reached maximum of {} inputs",
                total_swept_amount, effective_withdrawal_amount, MAX_SWEEP_INPUTS
            );
            break;
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
        let batch_escrow_balance = batch_escrow_inputs.iter().map(|(_, e, _)| e.amount).sum::<u64>();
        total_swept_amount += batch_escrow_balance;
        total_inputs_swept += batch_escrow_inputs.len();
        
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
        
        info!(
            "Kaspa sweeping: batch {} escrow inputs, fee: {} sompi, relayer output: {} sompi",
            batch_escrow_inputs.len(), estimated_fee, relayer_output_amount
        );
        
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
        info!("Kaspa sweeping: created PSKT {}", pskt_id);
    }
    
    info!(
        "Kaspa sweeping: completed with {} PSKTs, swept {} inputs totaling {} sompi (total available: {} sompi for {} sompi withdrawals)",
        bundle.0.len(), total_inputs_swept, total_swept_amount, anchor_amount + total_swept_amount, total_withdrawal_amount
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

    let relayer_input: PopulatedInput = (
        TransactionInput::new(
            TransactionOutpoint::new(tx_id, relayer_idx),
            vec![], // signature_script is empty for unsigned transactions
            u64::MAX,
            RELAYER_SIG_OP_COUNT,
        ),
        UtxoEntry::new(
            relayer_output.amount,
            relayer_output.script_public_key.clone(),
            UNACCEPTED_DAA_SCORE,
            false,
        ),
        None, // relayer has no redeem script
    );

    let escrow_input: PopulatedInput = (
        TransactionInput::new(
            TransactionOutpoint::new(tx_id, escrow_idx),
            vec![], // signature_script is empty for unsigned transactions
            u64::MAX,
            escrow.n() as u8,
        ),
        UtxoEntry::new(
            escrow_output.amount,
            escrow.p2sh.clone(),
            UNACCEPTED_DAA_SCORE,
            false,
        ),
        Some(escrow.redeem_script.clone()), // escrow has redeem script
    );

    Ok(vec![relayer_input, escrow_input])
}

pub(crate) fn utxo_reference_from_populated_input(
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

use crate::ops::migration::MigrationFXG;
use crate::ops::payload::MessageIDs;
use crate::ops::withdraw::query_hub_anchor;
use crate::providers::KaspaProvider;
use crate::relayer::withdraw::hub_to_kaspa::{
    combine_all_bundles, create_pskt, fetch_input_utxos, finalize_migration_txs,
    get_normal_bucket_feerate,
};
use dym_kas_core::pskt::{PopulatedInput, PopulatedInputBuilder};
use eyre::{eyre, Result};
use kaspa_addresses::Address;
use kaspa_consensus_core::tx::TransactionOutput;
use kaspa_txscript::pay_to_address_script;
use kaspa_wallet_pskt::prelude::*;
use std::sync::Arc;
use tracing::info;

/// Execute escrow key migration.
///
/// This function:
/// 1. Queries hub for current anchor and fetches all escrow UTXOs
/// 2. Verifies hub anchor is among escrow UTXOs
/// 3. Fetches relayer UTXOs to pay transaction fees
/// 4. Builds a PSKT that transfers all escrow funds to the new escrow (relayer pays fee)
/// 5. Collects signatures from validators
/// 6. Combines signatures and broadcasts the transaction
pub async fn execute_migration(
    provider: &KaspaProvider,
    new_escrow_address: &Address,
) -> Result<Vec<kaspa_hashes::Hash>> {
    let escrow = provider.escrow();
    let easy_wallet = provider.wallet();
    let validators_client = provider.validators();
    let hub_rpc = provider.hub_rpc().query();
    info!("Starting escrow key migration");

    // 1. Query hub for current anchor
    let hub_anchor = query_hub_anchor(hub_rpc)
        .await
        .map_err(|e| eyre!("Query hub anchor: {}", e))?;
    info!(
        tx_id = %hub_anchor.transaction_id,
        index = hub_anchor.index,
        "Got hub anchor"
    );

    // 2. Fetch all escrow UTXOs
    let escrow_addr = escrow.addr.clone();
    let escrow_utxos = easy_wallet
        .rpc_with_reconnect(|api| {
            let addr = escrow_addr.clone();
            async move {
                api.get_utxos_by_addresses(vec![addr])
                    .await
                    .map_err(|e| eyre!("Fetch escrow UTXOs: {}", e))
            }
        })
        .await?;

    if escrow_utxos.is_empty() {
        return Err(eyre!("No UTXOs found in escrow address"));
    }

    // 3. Verify hub anchor is among escrow UTXOs
    let hub_anchor_found = escrow_utxos.iter().any(|u| {
        u.outpoint.transaction_id == hub_anchor.transaction_id
            && u.outpoint.index == hub_anchor.index
    });
    if !hub_anchor_found {
        return Err(eyre!(
            "Hub anchor {}:{} not found in escrow UTXOs - state may be stale",
            hub_anchor.transaction_id,
            hub_anchor.index
        ));
    }

    let escrow_sum: u64 = escrow_utxos.iter().map(|u| u.utxo_entry.amount).sum();
    info!(
        utxo_count = escrow_utxos.len(),
        escrow_sum, "Fetched escrow UTXOs for migration"
    );

    // 4. Build escrow inputs
    let sig_op_count = escrow.n() as u8;
    let escrow_inputs: Vec<PopulatedInput> = escrow_utxos
        .into_iter()
        .map(|utxo| {
            PopulatedInputBuilder::new(
                utxo.outpoint.transaction_id,
                utxo.outpoint.index,
                utxo.utxo_entry.amount,
                escrow.p2sh.clone(),
            )
            .sig_op_count(sig_op_count)
            .block_daa_score(utxo.utxo_entry.block_daa_score)
            .redeem_script(Some(escrow.redeem_script.clone()))
            .build()
        })
        .collect();

    // 5. Fetch relayer UTXOs for fee payment
    let relayer_addr = easy_wallet.account().change_address()?;
    let network_id = easy_wallet.net.network_id;
    let relayer_addr_clone = relayer_addr.clone();
    let relayer_inputs = easy_wallet
        .rpc_with_reconnect(|api| {
            let addr = relayer_addr_clone.clone();
            async move {
                fetch_input_utxos(
                    &api, &addr, None, // No redeem script for relayer inputs
                    1,    // sig_op_count for P2PK
                    network_id,
                )
                .await
            }
        })
        .await
        .map_err(|e| eyre!("Fetch relayer UTXOs: {}", e))?;

    if relayer_inputs.is_empty() {
        return Err(eyre!(
            "Relayer has no UTXOs to pay migration fee - fund relayer address first"
        ));
    }

    let relayer_sum: u64 = relayer_inputs
        .iter()
        .map(|(_, entry, _)| entry.amount)
        .sum();
    info!(
        relayer_utxo_count = relayer_inputs.len(),
        relayer_sum, "Fetched relayer UTXOs for fee"
    );

    // 6. Calculate fee
    let feerate = easy_wallet
        .rpc_with_reconnect(|api| async move { get_normal_bucket_feerate(&api).await })
        .await?;

    // Estimate transaction mass (escrow inputs are heavier due to multisig)
    let num_inputs = escrow_inputs.len() + relayer_inputs.len();
    let num_outputs = 2; // migration target + relayer change
    let estimated_mass = estimate_migration_tx_mass(escrow_inputs.len(), relayer_inputs.len());
    let tx_fee = (estimated_mass as f64 * feerate).round() as u64;

    if relayer_sum <= tx_fee {
        return Err(eyre!(
            "Relayer balance {} insufficient for fee {}",
            relayer_sum,
            tx_fee
        ));
    }
    let relayer_change = relayer_sum - tx_fee;

    info!(
        feerate,
        estimated_mass, tx_fee, relayer_change, "Calculated migration fee"
    );

    // 7. Build inputs: escrow + relayer
    let mut inputs = escrow_inputs;
    inputs.extend(relayer_inputs);

    // 8. Build outputs: migration target (100% escrow funds) + relayer change
    let new_escrow_script = pay_to_address_script(new_escrow_address);
    let relayer_change_script = pay_to_address_script(&relayer_addr);
    let outputs = vec![
        TransactionOutput::new(escrow_sum, new_escrow_script),
        TransactionOutput::new(relayer_change, relayer_change_script),
    ];

    // 9. Build PSKT with empty MessageIDs payload (required by validation)
    let empty_payload = MessageIDs::new(vec![]).to_bytes();
    let pskt = create_pskt(inputs, outputs, Some(empty_payload))?;
    let bundle = Bundle::from(pskt);
    let fxg = MigrationFXG::new(bundle);

    info!(
        num_inputs,
        num_outputs, escrow_sum, "Built migration PSKT, collecting validator signatures"
    );

    // 10. Collect signatures from validators
    let bundles = validators_client
        .get_migration_sigs(Arc::new(fxg))
        .await
        .map_err(|e| eyre!("Collect migration signatures: {}", e))?;

    info!(
        bundle_count = bundles.len(),
        "Collected validator signatures"
    );

    // 11. Combine signatures and finalize
    let combined = combine_all_bundles(bundles)?;
    let finalized = finalize_migration_txs(
        combined,
        &escrow,
        easy_wallet.pub_key().await?,
        easy_wallet.net.network_id,
    )?;

    info!(
        tx_count = finalized.len(),
        "Finalized migration transactions"
    );

    // 12. Submit transactions
    let mut tx_ids = Vec::new();
    for tx in finalized {
        let tx_clone = tx.clone();
        let tx_id = easy_wallet
            .rpc_with_reconnect(|api| {
                let tx = tx_clone.clone();
                async move {
                    api.submit_transaction(tx, false)
                        .await
                        .map_err(|e| eyre!("Submit migration TX: {}", e))
                }
            })
            .await?;
        info!(tx_id = %tx_id, "Submitted migration transaction");
        tx_ids.push(tx_id);
    }

    info!(
        tx_count = tx_ids.len(),
        "Migration complete, all transactions submitted"
    );

    Ok(tx_ids)
}

/// Estimate transaction mass for migration.
/// Escrow inputs are heavier due to multisig redeem script.
fn estimate_migration_tx_mass(escrow_input_count: usize, relayer_input_count: usize) -> u64 {
    // Base transaction overhead
    const BASE_MASS: u64 = 100;
    // Escrow input mass (multisig with redeem script is heavier)
    const ESCROW_INPUT_MASS: u64 = 500;
    // Relayer input mass (simple P2PK)
    const RELAYER_INPUT_MASS: u64 = 150;
    // Output mass
    const OUTPUT_MASS: u64 = 50;
    // Outputs: migration target + relayer change
    const NUM_OUTPUTS: u64 = 2;

    BASE_MASS
        + (escrow_input_count as u64 * ESCROW_INPUT_MASS)
        + (relayer_input_count as u64 * RELAYER_INPUT_MASS)
        + (NUM_OUTPUTS * OUTPUT_MASS)
}

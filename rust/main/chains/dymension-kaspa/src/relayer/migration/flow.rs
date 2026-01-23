use crate::ops::migration::MigrationFXG;
use crate::ops::payload::MessageIDs;
use crate::ops::withdraw::query_hub_anchor;
use crate::providers::KaspaProvider;
use crate::relayer::withdraw::hub_to_kaspa::{
    combine_all_bundles, create_pskt, fetch_input_utxos, finalize_txs, get_normal_bucket_feerate,
    sign_relayer_fee,
};
use dym_kas_core::pskt::{estimate_mass, PopulatedInput, PopulatedInputBuilder};
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

    // 6. Build inputs: escrow + relayer
    let mut inputs = escrow_inputs;
    inputs.extend(relayer_inputs);
    let num_inputs = inputs.len();

    // 7. Build placeholder outputs to estimate mass (storage mass divides by output amount)
    let new_escrow_script = pay_to_address_script(new_escrow_address);
    let relayer_change_script = pay_to_address_script(&relayer_addr);
    let placeholder_outputs = vec![
        TransactionOutput::new(escrow_sum, new_escrow_script.clone()),
        TransactionOutput::new(relayer_sum, relayer_change_script.clone()),
    ];

    // 8. Calculate actual mass using Kaspa's mass calculator
    let empty_payload = MessageIDs::new(vec![]).to_bytes();
    let tx_mass = estimate_mass(
        inputs.clone(),
        placeholder_outputs,
        empty_payload.clone(),
        easy_wallet.net.network_id,
        escrow.m() as u16,
    )
    .map_err(|e| eyre!("Estimate migration TX mass: {}", e))?;

    // 9. Calculate fee and relayer change
    let feerate = easy_wallet
        .rpc_with_reconnect(|api| async move { get_normal_bucket_feerate(&api).await })
        .await?;
    let tx_fee = (tx_mass as f64 * feerate).round() as u64;

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
        tx_mass, tx_fee, relayer_change, "Calculated migration fee"
    );

    // 10. Build final outputs with correct relayer change
    let num_outputs = 2;
    let outputs = vec![
        TransactionOutput::new(escrow_sum, new_escrow_script),
        TransactionOutput::new(relayer_change, relayer_change_script),
    ];

    // 11. Build PSKT
    let pskt = create_pskt(inputs, outputs, empty_payload)?;
    let bundle = Bundle::from(pskt);
    let fxg = Arc::new(MigrationFXG::new(bundle));

    info!(
        num_inputs,
        num_outputs, escrow_sum, "Built migration PSKT, collecting validator signatures"
    );

    // 12. Collect signatures from validators
    let mut bundles = validators_client
        .get_migration_sigs(fxg.clone())
        .await
        .map_err(|e| eyre!("Collect migration signatures: {}", e))?;

    info!(
        bundle_count = bundles.len(),
        "Collected validator signatures"
    );

    // 13. Sign relayer fee inputs
    let relayer_bundle = sign_relayer_fee(easy_wallet, &fxg.bundle).await?;
    bundles.push(relayer_bundle);
    info!("Signed relayer fee inputs");

    // 14. Combine signatures and finalize
    let combined = combine_all_bundles(bundles)?;
    let finalized = finalize_txs(
        combined,
        &escrow,
        easy_wallet.pub_key().await?,
        easy_wallet.net.network_id,
    )?;

    info!(
        tx_count = finalized.len(),
        "Finalized migration transactions"
    );

    // 15. Submit transactions
    let mut tx_ids = Vec::new();
    for tx in finalized {
        let tx_id = easy_wallet
            .rpc_with_reconnect(|api| {
                let tx = tx.clone();
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

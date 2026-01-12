use crate::ops::migration::MigrationFXG;
use crate::providers::KaspaProvider;
use crate::relayer::withdraw::hub_to_kaspa::{
    combine_all_bundles, create_pskt, finalize_migration_txs,
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
/// 1. Fetches all UTXOs from the current escrow
/// 2. Builds a PSKT that transfers all funds to the new escrow
/// 3. Collects signatures from validators
/// 4. Combines signatures and broadcasts the transaction
pub async fn execute_migration(
    provider: &KaspaProvider,
    new_escrow_address: &Address,
) -> Result<Vec<kaspa_hashes::Hash>> {
    let escrow = provider.escrow();
    let easy_wallet = provider.wallet();
    let validators_client = provider.validators();
    info!("Starting escrow key migration");

    // 1. Fetch all escrow UTXOs
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

    let total_amount: u64 = escrow_utxos.iter().map(|u| u.utxo_entry.amount).sum();
    info!(
        utxo_count = escrow_utxos.len(),
        total_amount, "Fetched escrow UTXOs for migration"
    );

    // 2. Build migration PSKT
    let sig_op_count = escrow.n() as u8;
    let inputs: Vec<PopulatedInput> = escrow_utxos
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

    // Single output to new escrow (all funds minus fee buffer)
    // Fee will be deducted by the network from the total
    let new_escrow_script = pay_to_address_script(new_escrow_address);
    let output = TransactionOutput::new(total_amount, new_escrow_script);

    // No payload for migration transactions
    let pskt = create_pskt(inputs, vec![output], None)?;
    let bundle = Bundle::from(pskt);
    let fxg = MigrationFXG::new(bundle);

    info!("Built migration PSKT, collecting validator signatures");

    // 3. Collect signatures from validators
    // Note: get_migration_sigs uses collect_with_threshold internally,
    // which already enforces the threshold requirement before returning
    let bundles = validators_client
        .get_migration_sigs(Arc::new(fxg))
        .await
        .map_err(|e| eyre!("Collect migration signatures: {}", e))?;

    info!(
        bundle_count = bundles.len(),
        "Collected validator signatures"
    );

    // 4. Combine signatures

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

    // 5. Submit transactions
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

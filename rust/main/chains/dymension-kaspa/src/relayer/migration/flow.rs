use crate::ops::migration::MigrationFXG;
use crate::providers::ValidatorsClient;
use crate::relayer::withdraw::hub_to_kaspa::{combine_all_bundles, finalize_migration_txs};
use dym_kas_core::escrow::EscrowPublic;
use dym_kas_core::pskt::input_sighash_type;
use dym_kas_core::wallet::EasyKaspaWallet;
use eyre::{eyre, Result};
use kaspa_addresses::Address;
use kaspa_consensus_core::tx::{
    TransactionInput, TransactionOutpoint, TransactionOutput, UtxoEntry,
};
use kaspa_txscript::pay_to_address_script;
use kaspa_wallet_pskt::prelude::*;
use kaspa_wallet_pskt::pskt::{InputBuilder, OutputBuilder, PSKT};
use std::sync::Arc;
use tracing::info;

type PopulatedInput = (TransactionInput, UtxoEntry, Option<Vec<u8>>);

/// Execute escrow key migration.
///
/// This function:
/// 1. Fetches all UTXOs from the current escrow
/// 2. Builds a PSKT that transfers all funds to the new escrow
/// 3. Collects signatures from validators
/// 4. Combines signatures and broadcasts the transaction
pub async fn execute_migration(
    validators_client: &ValidatorsClient,
    easy_wallet: &EasyKaspaWallet,
    escrow: &EscrowPublic,
    new_escrow_address: &Address,
) -> Result<Vec<kaspa_hashes::Hash>> {
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
            let input = TransactionInput::new(
                TransactionOutpoint::new(utxo.outpoint.transaction_id, utxo.outpoint.index),
                vec![],
                0,
                sig_op_count,
            );
            let entry = UtxoEntry::new(
                utxo.utxo_entry.amount,
                escrow.p2sh.clone(),
                utxo.utxo_entry.block_daa_score,
                utxo.utxo_entry.is_coinbase,
            );
            (input, entry, Some(escrow.redeem_script.clone()))
        })
        .collect();

    // Single output to new escrow (all funds minus fee buffer)
    // Fee will be deducted by the network from the total
    let new_escrow_script = pay_to_address_script(new_escrow_address);
    let output = TransactionOutput::new(total_amount, new_escrow_script);

    let pskt = create_migration_pskt(inputs, vec![output])?;
    let bundle = Bundle::from(pskt);
    let fxg = MigrationFXG::new(bundle);

    info!("Built migration PSKT, collecting validator signatures");

    // 3. Collect signatures from validators
    let fxg_arc = Arc::new(fxg);
    let bundles = validators_client
        .get_migration_sigs(fxg_arc.clone())
        .await
        .map_err(|e| eyre!("Collect migration signatures: {}", e))?;

    info!(
        bundle_count = bundles.len(),
        "Collected validator signatures"
    );

    // 4. Combine signatures
    let threshold = validators_client.multisig_threshold_escrow();
    if bundles.len() < threshold {
        return Err(eyre!(
            "Not enough validator signatures: got {}, need {}",
            bundles.len(),
            threshold
        ));
    }

    let combined = combine_all_bundles(bundles)?;
    let finalized = finalize_migration_txs(
        combined,
        escrow,
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

fn create_migration_pskt(
    inputs: Vec<PopulatedInput>,
    outputs: Vec<TransactionOutput>,
) -> Result<PSKT<Signer>> {
    let mut pskt = PSKT::<Creator>::default()
        .set_version(Version::One)
        .constructor();

    // Add inputs
    for (input, entry, redeem_script) in inputs.into_iter() {
        let mut b = InputBuilder::default();

        b.utxo_entry(entry)
            .previous_outpoint(input.previous_outpoint)
            .sig_op_count(input.sig_op_count)
            .sighash_type(input_sighash_type());

        if let Some(script) = redeem_script {
            b.redeem_script(script);
        }

        pskt = pskt.input(b.build().map_err(|e| eyre!("Build PSKT input: {}", e))?);
    }

    // Add outputs
    for output in outputs.into_iter() {
        let b = OutputBuilder::default()
            .amount(output.value)
            .script_public_key(output.script_public_key)
            .build()
            .map_err(|e| eyre!("Build PSKT output: {}", e))?;

        pskt = pskt.output(b);
    }

    // No payload for migration
    Ok(pskt.no_more_inputs().no_more_outputs().signer())
}

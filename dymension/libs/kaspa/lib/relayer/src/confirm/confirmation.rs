use eyre::Result;
use tracing::info;

use api_rs::models::TxModel;
use kaspa_consensus_core::tx::TransactionOutpoint;

use kaspa_wallet_core::error::Error;

use corelib::api::client::HttpClient;

use corelib::{confirmation::ConfirmationFXG, payload::MessageID};
use hex;

/// WARNING: ONLY FOR UNHAPPY PATH
///
/// Traces transactions in reverse from a new UTXO to an old anchor UTXO, collecting
/// all withdrawal payloads that were processed in between. This follows the transaction
/// lineage of the escrow address to create a confirmation progress indication.
///
/// # Arguments
/// * `client` - The HTTP client for querying Kaspa API transactions
/// * `escrow_addresses` - The escrow address to trace transactions for
/// * `new_out` - The new transaction outpoint to start tracing from
/// * `old_out` - The old anchor transaction outpoint to trace to
///
/// # Returns
/// * `Result<ConfirmationFXG>` - The confirmation FXG containing the progress indication
///   with old and new outpoints and a list of processed withdrawal message IDs
pub async fn expensive_trace_transactions(
    client: &HttpClient,
    escrow_addresses: &str,
    new_out: TransactionOutpoint,
    old_out: TransactionOutpoint,
) -> Result<ConfirmationFXG> {
    info!(
        "Starting transaction trace from candidate new anchor {:?} to old anchor {:?}",
        new_out, old_out
    );

    let mut processed_withdrawals: Vec<MessageID> = Vec::new();
    let mut lineage_utxos = Vec::new();

    // get the lineage utxos
    let res = recursive_trace_transactions(
        client,
        escrow_addresses,
        new_out,
        old_out,
        &mut lineage_utxos,
        &mut processed_withdrawals,
    )
    .await;
    if res.is_err() {
        return Err(eyre::eyre!(
            "Failed to trace transactions: {}",
            res.err().unwrap()
        ));
    }

    info!(
        "Trace completed. Found {} UTXOs in lineage with {} processed withdrawals",
        lineage_utxos.len(),
        processed_withdrawals.len()
    );
    for utxo in lineage_utxos.clone() {
        info!("Lineage UTXO: {:?}", utxo);
    }

    Ok(ConfirmationFXG::from_msgs_outpoints(
        processed_withdrawals,
        lineage_utxos,
    ))
}

pub async fn recursive_trace_transactions(
    client: &HttpClient,
    escrow_addresses: &str,
    curr_utxo: TransactionOutpoint,
    anchor_utxo: TransactionOutpoint,
    lineage_utxos: &mut Vec<TransactionOutpoint>,
    processed_withdrawals: &mut Vec<MessageID>,
) -> Result<()> {
    // if curr_utxo is the anchor_utxo, add it to the lineage and return
    // this will wrap up the recursive call
    if curr_utxo == anchor_utxo {
        lineage_utxos.push(curr_utxo);
        return Ok(());
    }

    info!("Tracing lineage from UTXO: {:?}", curr_utxo);

    // get the transaction
    let transaction = client
        .get_tx_by_id(&curr_utxo.transaction_id.to_string())
        .await?;

    info!("Queried kaspa tx: {:?}", transaction);

    // get the inputs of the current transaction
    let inputs = transaction
        .inputs
        .as_ref()
        .ok_or(Error::Custom("Inputs not found".to_string()))?;

    // follow inputs
    // we skip inputs that are not from the escrow address
    // we do recursive call for inputs that are from the escrow address
    for input in inputs {
        info!("Checking input: {:?}", input.index);

        let input_address = input
            .previous_outpoint_address
            .as_ref()
            .ok_or(Error::Custom("Input address not found".to_string()))?;

        // skip input if not my address
        if input_address != escrow_addresses {
            info!(
                "Skipping input from non-escrow address: {:?}",
                input_address
            );
            continue;
        }

        // TODO: have ::From method to get utxo from TxInput
        let input_utxo = TransactionOutpoint {
            transaction_id: kaspa_hashes::Hash::from_bytes(
                hex::decode(&input.previous_outpoint_hash)?
                    .try_into()
                    .map_err(|_| eyre::eyre!("Invalid hex in previous_outpoint_hash"))?,
            ),
            index: input.previous_outpoint_index.parse()?,
        };

        // do recursive call
        let res = Box::pin(recursive_trace_transactions(
            client,
            escrow_addresses,
            input_utxo,
            anchor_utxo,
            lineage_utxos,
            processed_withdrawals,
        ))
        .await;

        // if returns error, this input is not part of the lineage, continue to other input
        if res.is_err() {
            continue;
        }

        /* ------------ if returns OK, the input is part of the lineage! ------------ */
        let payload = transaction
            .payload
            .clone()
            .ok_or_else(|| eyre::eyre!("No payload found in transaction"))?;

        let message_ids = corelib::payload::MessageIDs::from_tx_payload(&payload)?;

        // add to the result
        processed_withdrawals.extend(message_ids.0);
        lineage_utxos.push(input_utxo);
        return Ok(());
    }

    // if reached here, return error as we're not followed the lineage
    Err(eyre::eyre!("No lineage UTXOs found in transaction inputs"))
}

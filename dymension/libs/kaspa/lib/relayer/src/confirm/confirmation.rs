use eyre::eyre;
use eyre::Result;
use tracing::info;

use api_rs::models::TxModel;
use kaspa_consensus_core::tx::TransactionOutpoint;

use kaspa_wallet_core::error::Error;

use api_rs::apis::{
    configuration::Configuration,
    kaspa_transactions_api::{
        get_transaction_transactions_transaction_id_get,
        GetTransactionTransactionsTransactionIdGetParams,
    },
};

use corelib::api::client::HttpClient;

use corelib::{confirmation::ConfirmationFXG, payload::MessageID};
use hex;

/// WARNING: ONLY FOR UNHAPPY PATH
/// /// Prepare a progress indication and create a ConfirmationFXG for the Hub x/kas module
/// This function traces back from a new UTXO to the old UTXO and collects
/// all withdrawal payloads that were processed in between.
///
/// # Arguments
/// * `config` - The Kaspa API client configuration for querying transactions
/// * `anchor_utxo` - The anchor UTXO to trace to
/// * `new_utxo` - The new UTXO to trace from
///
/// # Returns
/// * `Result<ConfirmationFXG, Error>` - The confirmation FXG containing the progress indication with old and new outpoints
///   and a list of processed withdrawal ID
/// Trace transactions in reverse, from a recent unspent UTXO to an already spent UTXO
/// collecting payloads along the way.
/// Follows the transaction lineage of the escrow address.
///
/// # Arguments
/// * `config` - The Kaspa API client configuration for querying transactions
/// * `new_utxo` - The transaction ID to start tracing from
/// * `current_anchor_utxo` - The transaction ID to trace to
///
/// # Returns
/// * `Result<Vec<WithdrawalId>, Error>` - Vector of collected withdrawal IDs from the transactions
pub async fn expensive_trace_transactions(
    client: &HttpClient,
    new_out: TransactionOutpoint,
    old_out: TransactionOutpoint,
) -> Result<ConfirmationFXG> {
    info!(
        "Starting transaction trace from candidate new anchor {:?} to old anchor {:?}",
        new_out, old_out
    );

    let mut processed_withdrawals: Vec<MessageID> = Vec::new();
    let mut outpoints: Vec<TransactionOutpoint> = Vec::new();
    let mut curr_out = new_out;
    let mut step = 0;
    let max_steps = 10;
    while curr_out != old_out {
        // Add a reasonable step limit to prevent infinite loops
        step += 1;
        if step > max_steps {
            return Err(eyre::eyre!(
                "Exceeded maximum number of steps in transaction trace"
            ));
        }

        info!("Processing depth {}: outpoint {:?}", step, curr_out);

        let transaction = client
            .get_tx_by_id(&curr_out.transaction_id.to_string())
            .await?;

        // Parse the payload string to extract the message ID
        if let Some(payload) = transaction.payload.clone() {
            let unhexed_payload = hex::decode(&payload)
                .map_err(|e| eyre::eyre!("Failed to decode payload: {}", e))?;
            // Deserialize the payload bytes into MessageIDs
            let message_ids =
                corelib::payload::MessageIDs::from_bytes(&unhexed_payload).map_err(|e| {
                    eyre::eyre!(
                        "Failed to deserialize MessageIDs: Payload: {} Err: {}",
                        payload,
                        e
                    )
                })?;

            // Convert each message ID into a WithdrawalId and add to the list
            processed_withdrawals.extend(message_ids.0);
        } else {
            return Err(eyre::eyre!("No payload found in transaction"));
        }

        // get the lineage address of the current utxo
        let lineage_address = transaction
            .outputs
            .as_ref()
            .ok_or(Error::Custom("Transaction outputs not found".to_string()))?
            .get(curr_out.index as usize)
            .ok_or(Error::Custom(format!(
                "Output index {} not found",
                curr_out.index
            )))?
            .script_public_key_address
            .as_ref()
            .ok_or(Error::Custom(
                "Script public key address not found".to_string(),
            ))?
            .clone();

        outpoints.push(curr_out);

        // Find the next UTXO to trace by checking all inputs
        // not supposed to happen in current design (we assume single hop between anchor and new UTXO)
        match get_previous_utxo_in_lineage(&transaction, &lineage_address, old_out) {
            Ok(Some(next_out)) => curr_out = next_out,
            Ok(None) => break, // Reached the break point
            Err(e) => return Err(eyre::eyre!(e)),
        }
    }

    info!(
        "Trace completed. Found {} transactions with payloads in {} steps",
        processed_withdrawals.len(),
        step
    );

    // it should start with old and end with new
    outpoints.push(old_out);
    outpoints.reverse();

    Ok(ConfirmationFXG::from_msgs_outpoints(
        processed_withdrawals,
        outpoints,
    ))
}

pub fn get_previous_utxo_in_lineage(
    transaction: &TxModel,
    lineage_address: &str,
    anchor_utxo: TransactionOutpoint,
) -> Result<Option<TransactionOutpoint>> {
    let inputs = transaction
        .inputs
        .as_ref()
        .ok_or(Error::Custom("Inputs not found".to_string()))?;
    // check if we reached the anchor transaction_id
    for input in inputs {
        info!("Checking input: {:?}", input.index);

        // If this input's previous_outpoint_hash matches the anchor transaction_id, break
        if input.previous_outpoint_hash == anchor_utxo.transaction_id.to_string()
            && input.previous_outpoint_index == anchor_utxo.index.to_string()
        {
            info!(
                "Reached anchor transaction_id in input: {}",
                input.previous_outpoint_hash
            );
            return Ok(None);
        }

        // check if this input is canonical (part of the escrow account lineage)
        let input_address = input
            .previous_outpoint_address
            .as_ref()
            .ok_or(Error::Custom(
                "Previous outpoint address not found".to_string(),
            ))?;
        if input_address == lineage_address {
            // Use the previous outpoint of this canonical input as the next UTXO
            let prev_hash_bytes = hex::decode(&input.previous_outpoint_hash).map_err(|e| {
                Error::Custom(format!("Invalid hex in previous_outpoint_hash: {}", e))
            })?;
            let next_utxo = TransactionOutpoint {
                transaction_id: kaspa_hashes::Hash::from_bytes(
                    prev_hash_bytes
                        .try_into()
                        .map_err(|_| Error::Custom("Invalid length for hash".to_string()))?,
                ),
                index: input.previous_outpoint_index.parse().unwrap(),
            };
            info!("Found next lineage UTXO: {:?}", next_utxo);
            return Ok(Some(next_utxo));
        }
    }

    Err(eyre::eyre!("No previous UTXO found in transaction"))
}

use anyhow::Result;
use hyperlane_cosmos_native::CosmosNativeProvider;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{
    ProgressIndication, QueryOutpointRequest, WithdrawalId,
};

use kaspa_consensus_core::tx::{ScriptPublicKey, TransactionId, TransactionOutpoint, UtxoEntry};
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_rpc_core::RpcTransaction;
use api_rs::models::TxModel;

use kaspa_addresses::Address;
use kaspa_wallet_core::error::Error;

use api_rs::apis::{
    configuration::Configuration,
    kaspa_transactions_api::{
        get_transaction_transactions_transaction_id_get,
        GetTransactionTransactionsTransactionIdGetParams,
    },
};

use hex;
use corelib::confirmation::ConfirmationFXG;
use corelib::payload::MessageID;

/// Prepare a progress indication and create a ConfirmationFXG for the Hub x/kas module
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
///   and a list of processed withdrawal IDs
pub async fn prepare_progress_indication(
    config: &Configuration,
    anchor_utxo: TransactionOutpoint,
    new_utxo: TransactionOutpoint,
) -> Result<ConfirmationFXG> {
    println!("Preparing progress indication for new UTXO: {:?}", new_utxo);

    // Trace transactions from the new UTXO back to the old one.
    println!("Tracing transactions to extract withdrawal IDs...");
    let msg_ids = trace_transactions(config, new_utxo, anchor_utxo).await?;

    let withdrawal_ids: Vec<WithdrawalId> = msg_ids.into_iter().map(|id| WithdrawalId {
        message_id: id.0.to_string(),
    }).collect();

    println!(
        "Extracted {} withdrawal IDs from payloads",
        withdrawal_ids.len()
    );

    let new_outpoint_indication =
        hyperlane_cosmos_rs::dymensionxyz::dymension::kas::TransactionOutpoint {
            transaction_id: new_utxo.transaction_id.as_bytes().to_vec(),
            index: new_utxo.index,
        };

    let anchor_outpoint_indication =
        hyperlane_cosmos_rs::dymensionxyz::dymension::kas::TransactionOutpoint {
            transaction_id: anchor_utxo.transaction_id.as_bytes().to_vec(),
            index: anchor_utxo.index,
        };

    let progress_indication = ProgressIndication {
        old_outpoint: Some(anchor_outpoint_indication),
        new_outpoint: Some(new_outpoint_indication),
        processed_withdrawals: withdrawal_ids,
    };

    println!("ProgressIndication: {:?}", progress_indication);

    let confirmation_fxg = ConfirmationFXG::new(progress_indication);
    Ok(confirmation_fxg)
}

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
pub async fn trace_transactions(
    config: &Configuration,
    new_utxo: TransactionOutpoint,
    anchor_utxo: TransactionOutpoint,
) -> Result<Vec<MessageID>> {
    println!(
        "Starting transaction trace from {:?} to {:?}",
        new_utxo, anchor_utxo
    );

    let mut processed_withdrawals: Vec<MessageID> = Vec::new();
    let mut current_utxo = new_utxo;
    let mut step = 0;
    let max_steps = 10;
    while current_utxo != anchor_utxo {
        // Add a reasonable step limit to prevent infinite loops
        step += 1;
        if step > max_steps {
            return Err(anyhow::anyhow!(
                "Exceeded maximum number of steps in transaction trace"
            ));
        }

        println!("Processing step {}: UTXO {:?}", step, current_utxo);

        let transaction = get_transaction_transactions_transaction_id_get(
            config,
            GetTransactionTransactionsTransactionIdGetParams {
                transaction_id: current_utxo.transaction_id.to_string(),
                block_hash: None,
                inputs: Some(true),
                outputs: Some(true),
                resolve_previous_outpoints: Some("light".to_string()),
            },
        )
        .await
        .map_err(|e| {
            anyhow::anyhow!(
                "Failed to get transaction {}: {}",
                current_utxo.transaction_id, e
            )
        })?;

        // Parse the payload string to extract the message ID
        if let Some(payload) = transaction.payload.clone() {
            // Deserialize the payload bytes into MessageIDs
            let message_ids = corelib::payload::MessageIDs::from_bytes(payload.as_bytes())
                .map_err(|e| anyhow::anyhow!("Failed to deserialize MessageIDs: {}", e))?;
            
            // Convert each message ID into a WithdrawalId and add to the list
            processed_withdrawals.extend(message_ids.0);
        } else {
            return Err(anyhow::anyhow!("No payload found in transaction"));
        }

        // get the lineage address of the current utxo
        let lineage_address = transaction
            .outputs
            .as_ref()
            .ok_or(Error::Custom("Transaction outputs not found".to_string()))?
            .get(current_utxo.index as usize)
            .ok_or(Error::Custom(format!(
                "Output index {} not found",
                current_utxo.index
            )))?
            .script_public_key_address
            .as_ref()
            .ok_or(Error::Custom(
                "Script public key address not found".to_string(),
            ))?
            .clone();

        // Find the next UTXO to trace by checking all inputs
        // not supposed to happen in current design (we assume single hop between anchor and new UTXO)
        match get_previous_utxo_in_lineage(&transaction, &lineage_address, anchor_utxo) {
            Ok(Some(next_utxo)) => current_utxo = next_utxo,
            Ok(None) => break, // Reached the break point
            Err(e) => return Err(anyhow::anyhow!(e)),
        }
    }

    println!(
        "Trace completed. Found {} transactions with payloads in {} steps",
        processed_withdrawals.len(),
        step
    );
    Ok(processed_withdrawals)
}

pub fn get_previous_utxo_in_lineage(
    transaction: &TxModel,
    lineage_address: &str,
    anchor_utxo: TransactionOutpoint,
) -> Result<Option<TransactionOutpoint>> {
    let inputs = transaction.inputs.as_ref().ok_or(Error::Custom("Inputs not found".to_string()))?;
    // check if we reached the anchor transaction_id
    for input in inputs {
        println!("Checking input: {:?}", input.index);

        // If this input's previous_outpoint_hash matches the anchor transaction_id, break
        if input.previous_outpoint_hash == anchor_utxo.transaction_id.to_string()
            && input.previous_outpoint_index == anchor_utxo.index.to_string()
        {
            println!(
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
            let prev_hash_bytes = hex::decode(&input.previous_outpoint_hash)
                .map_err(|e| Error::Custom(format!("Invalid hex in previous_outpoint_hash: {}", e)))?;
            let next_utxo = TransactionOutpoint {
                transaction_id: kaspa_hashes::Hash::from_bytes(
                    prev_hash_bytes.try_into().map_err(|_| Error::Custom("Invalid length for hash".to_string()))?
                ),
                index: input.previous_outpoint_index.parse().unwrap(),
            };
            println!("Found next lineage UTXO: {:?}", next_utxo);
            return Ok(Some(next_utxo));
        }
    }

    Err(anyhow::anyhow!("No previous UTXO found in transaction"))
}

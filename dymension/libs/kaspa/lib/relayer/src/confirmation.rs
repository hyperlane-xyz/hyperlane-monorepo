use anyhow::Result;
use hyperlane_cosmos_native::CosmosNativeProvider;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{
    ProgressIndication, QueryOutpointRequest, WithdrawalId,
};

use kaspa_consensus_core::tx::{ScriptPublicKey, TransactionId, UtxoEntry, TransactionOutpoint};
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_rpc_core::RpcTransaction;

use kaspa_wallet_core::error::Error;
use kaspa_addresses::Address;

use api_rs::apis::{
    configuration::Configuration,
    kaspa_transactions_api::{
        get_transaction_transactions_transaction_id_get,
        GetTransactionTransactionsTransactionIdGetParams,
    },
};

use core::confirmation::ConfirmationFXG;

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
) -> Result<ConfirmationFXG, Error> {
    println!("Preparing progress indication for new UTXO: {:?}", new_utxo);

    /*
    // DISABLED, assumed to be supplied by the caller

    // Step 1: Query the old_outpoint using the cosmos_provider
    println!("Step 1: Querying old outpoint from Hub x/kas module...");
    let old_outpoint_response = cosmos_provider
        .grpc()
        .outpoint(None)
        .await
        .map_err(|e| {
            let error_msg = format!("Failed to query outpoint from x/kas module: {}", e);
            println!("Error: {}", error_msg);
            Error::Custom(error_msg)
        })?;
        // TODO: add validation that the old outpoint is valid?
        println!("Old outpoint retrieved: {:?}", old_outpoint);
    */



    // FIXME: validate new_utxo and current_utxo transaction
    // - validate both addresses are the escrow address
    // - validate both txs are fine and confirmed/matured(?) 
    
    
    

    // Trace transactions from the new UTXO back to the old one.
    println!("Tracing transactions to extract withdrawal IDs...");
    let processed_withdrawals: Vec<WithdrawalId> = trace_transactions(
        config,
        new_utxo,
        anchor_utxo
    ).await?;
    println!("Extracted {} withdrawal IDs from payloads", processed_withdrawals.len());


    // Create new outpoint for the progress indication
    let new_outpoint_indication = Some(hyperlane_cosmos_rs::dymensionxyz::dymension::kas::TransactionOutpoint {
        transaction_id: new_utxo.transaction_id.as_bytes().to_vec(),
        index: new_utxo.index,
    });
    let anchor_outpoint_indication = Some(hyperlane_cosmos_rs::dymensionxyz::dymension::kas::TransactionOutpoint {
        transaction_id: anchor_utxo.transaction_id.as_bytes().to_vec(),
        index: anchor_utxo.index,
    });

    let progress_indication = ProgressIndication {
        old_outpoint: anchor_outpoint_indication,
        new_outpoint: new_outpoint_indication,
        processed_withdrawals,
    };

    println!("ProgressIndication: {:?}", progress_indication);

    let confirmation_fxg = ConfirmationFXG::new(progress_indication);
    Ok(confirmation_fxg)
}

/// Trace transactions from a starting transaction ID to a target transaction ID,
/// collecting payloads along the way.
/// 
/// # Arguments
/// * `config` - The Kaspa API client configuration for querying transactions
/// * `new_utxo` - The transaction ID to start tracing from
/// * `current_anchor_utxo` - The transaction ID to trace to
/// 
/// # Returns
/// * `Result<Vec<WithdrawalId>, Error>` - Vector of collected withdrawal IDs from the transactions
async fn trace_transactions(
    config: &Configuration,
    new_utxo: TransactionOutpoint,
    current_anchor_utxo: TransactionOutpoint,
) -> Result<Vec<WithdrawalId>, Error> {
    
    println!("Starting transaction trace from {:?} to {:?}", 
    new_utxo, current_anchor_utxo);
    
    

    
    let mut processed_withdrawals: Vec<WithdrawalId> = Vec::new();
    let mut current_utxo = new_utxo;
    let mut step = 0;
    let max_steps = 10;
    while current_utxo != current_anchor_utxo {
        // Add a reasonable step limit to prevent infinite loops
        step += 1;
        if step > max_steps {
            return Err(Error::Custom("Exceeded maximum number of steps in transaction trace".to_string()));
        }

        println!("Processing step {}: UTXO {:?}", step, current_utxo);

        let transaction = get_transaction_transactions_transaction_id_get(
            config,
            GetTransactionTransactionsTransactionIdGetParams {
                transaction_id: current_utxo.transaction_id.to_string(),
                block_hash: None,
                inputs: Some(true),
                outputs: Some(true),
                resolve_previous_outpoints: Some("full".to_string()),
            },
        ).await.map_err(|e| {
            Error::Custom(format!("Failed to get transaction {}: {}", current_utxo.transaction_id, e))
        })?;

        // Extract payload from transaction
        if let Some(payload) = transaction.payload {
            println!("Found payload in transaction: {:?}", payload);
            // Parse the payload string to extract the message ID
            // FIXME: might need tuning after integration
            let withdrawal_id = WithdrawalId {
                message_id: payload,
            };
            processed_withdrawals.push(withdrawal_id);
        } else {
            return Err(Error::Custom("No payload found in transaction".to_string()));
        }

        // Find the next UTXO to trace by checking all inputs
        let mut found_anchor = false;
        if let Some(inputs) = &transaction.inputs {
            // check if we reached the anchor transaction_id
            for input in inputs {
                // Validate previous_outpoint_hash populated
                if input.previous_outpoint_hash.is_empty() {
                    return Err(Error::Custom("Empty previous_outpoint_hash".to_string()));
                }

                // If this input's previous_outpoint_hash matches the anchor transaction_id, break
                if input.previous_outpoint_hash == current_anchor_utxo.transaction_id.to_string() {
                    println!("Reached anchor transaction_id in input: {}", input.previous_outpoint_hash);
                    found_anchor = true;
                    break;
                }
            }
        }
                
        if found_anchor {
            break;
        }


        // FIXME: this logic needs rework. currently we assume single hop, which supposed to be handled above
        let mut found_next_utxo = false;
        if let Some(inputs) = transaction.inputs {
            for input in &inputs {
                println!("Checking input: {:?}", input.index);
                // check if this input is canonical (part of the escrow account lineage)
                if check_if_input_is_canonical(input) {
                    // Use the previous outpoint of this canonical input as the next UTXO
                    current_utxo = TransactionOutpoint {
                        transaction_id: kaspa_hashes::Hash::from_bytes(
                            input.previous_outpoint_hash.as_bytes().try_into().unwrap()
                        ),
                        index: input.previous_outpoint_index.parse().unwrap(),
                    };
                    found_next_utxo = true;
                    println!("Found next canonical UTXO: {:?}", current_utxo);
                    break;
                }
            }
        }

        if !found_next_utxo {
            let error_msg = "No next UTXO found in transaction".to_string();
            println!("Error: {}", error_msg);
            return Err(Error::Custom(error_msg));
        }
    }

    println!("Trace completed. Found {} transactions with payloads in {} steps", 
             processed_withdrawals.len(), step);
    Ok(processed_withdrawals)
}


// This is a placeholder for the canonical input check logic.
// It should be implemented to find the TxInput that is canonical (part of the escrow account lineage)
fn check_if_input_is_canonical(_input: &api_rs::models::TxInput) -> bool {
    // FIXME: implement canonical input check logic here
    println!("Called check_if_input_is_canonical");
    true
}


// FIXME: AI generated tests. review and rewrite
#[cfg(test)]
mod tests {
    use super::*;
    use kaspa_consensus_core::tx::TransactionId;
    use kaspa_hashes::Hash;

    #[test]
    fn test_withdrawal_id_creation() {
        // Test creating a WithdrawalId with a message ID
        let message_id = "test_message_id_1234567890abcdef".to_string();
        let withdrawal_id = WithdrawalId {
            message_id: message_id.clone(),
        };
        
        assert_eq!(withdrawal_id.message_id, message_id);
    }

    #[test]
    fn test_transaction_id_conversion() {
        // Test that TransactionId can be converted to bytes and back
        let original_tx_id = TransactionId::from_bytes([1u8; 32]);
        let bytes = original_tx_id.as_bytes();
        let converted_tx_id = TransactionId::from_bytes(*bytes);
        assert_eq!(original_tx_id, converted_tx_id);
    }
}
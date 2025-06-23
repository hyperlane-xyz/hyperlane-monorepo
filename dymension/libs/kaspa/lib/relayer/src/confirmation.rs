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



/// Trace transactions from a starting transaction ID to a target transaction ID,
/// collecting payloads along the way.
/// 
/// # Arguments
/// * `config` - The Kaspa API client configuration for querying transactions
/// * `addr` - The address of the UTXO
/// * `start_tx_id` - The transaction ID to start tracing from
/// * `target_tx_id` - The transaction ID to trace to
/// * `start_output_index` - The output index in the starting transaction (usually 0 for anchor UTXO)
/// 
/// # Returns
/// * `Result<Vec<Vec<u8>>, Error>` - Vector of collected payloads from the transactions
async fn trace_transactions(
    config: &Configuration,
    new_utxo: TransactionOutpoint,
    current_anchor_utxo: TransactionOutpoint,
) -> Result<Vec<Vec<u8>>, Error> {
    
    println!("Starting transaction trace from {:?} to {:?}", 
    new_utxo, current_anchor_utxo);
    
    


    // FIXME: validate new_utxo and current_utxo transaction
    // - validate both addresses are the escrow address
    // - validate both txs are fine and confirmed/matured(?) 
    
    
    
    let mut processed_withdrawals_payload: Vec<Vec<u8>> = Vec::new();
    let mut current_utxo = new_utxo;
    let mut step = 0;
    let max_steps = 10;
    while current_utxo != current_anchor_utxo {
        // Add a reasonable step limit to prevent infinite loops
        step += 1;
        if step > max_steps {
            let error_msg = "Exceeded maximum number of steps in transaction trace".to_string();
            println!("Error: {}", error_msg);
            return Err(Error::Custom(error_msg));
        }

        println!("Processing step {}: UTXO {:?}", step, current_utxo);

        let transaction = get_transaction_transactions_transaction_id_get(
            config,
            GetTransactionTransactionsTransactionIdGetParams {
                transaction_id: current_utxo.transaction_id.to_string(),
                block_hash: None,
                inputs: Some(true),
                outputs: Some(true),
                resolve_previous_outpoints: None,
            },
        ).await.map_err(|e| {
            Error::Custom(format!("Failed to get transaction {}: {}", current_utxo.transaction_id, e))
        })?;

        // Extract payload from transaction
        if let Some(payload) = transaction.payload {
            println!("Found payload in transaction: {:?}", payload);
            processed_withdrawals_payload.push(payload.into_bytes());
        } else {
            return Err(Error::Custom("No payload found in transaction".to_string()));
        }

        // Find the next UTXO to trace by checking all inputs
        let mut found_anchor = false;
        if let Some(inputs) = transaction.inputs {
            // check if we reached the anchor transaction_id
            for input in &inputs {
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
                    current_utxo = TransactionOutpoint {
                        transaction_id: TransactionId::from_bytes(input.previous_outpoint_hash.as_bytes()),
                        index: input.previous_outpoint_index,
                    };
                    found_next_utxo = true;
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
             processed_withdrawals_payload.len(), step);
    Ok(processed_withdrawals_payload)
}

/// Prepare a progress indication for the Hub x/kas module
/// This function traces back from a new UTXO to the old UTXO and collects
/// all withdrawal payloads that were processed in between.
/// 
/// # Arguments
/// * `config` - The Kaspa API client configuration for querying transactions
/// * `cosmos_provider` - The Cosmos provider for querying Hub state
/// * `addr` - The address of the UTXO
/// * `new_utxo_transaction_id` - The transaction ID of the new UTXO to trace from
/// 
/// # Returns
/// * `Result<ProgressIndication, Error>` - The progress indication with old and new outpoints
///   and a list of processed withdrawal IDs
pub async fn prepare_progress_indication(
    config: &Configuration,
    // cosmos_provider: &CosmosNativeProvider,
    // addr: Address,
    anchor_utxo: TransactionOutpoint,
    new_utxo: TransactionOutpoint,
) -> Result<ProgressIndication, Error> {
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
    

    // Step 2: Trace transactions from the new UTXO back to the old one.
    let processed_withdrawals_payload = trace_transactions(
        config,
        new_utxo,
        anchor_utxo
    ).await?;

    // Step 3: Parse payloads to extract withdrawal IDs
    println!("Step 3: Parsing payloads to extract withdrawal IDs...");
    let processed_withdrawals: Vec<WithdrawalId> = parse_withdrawal_payloads(&processed_withdrawals_payload)?;
    println!("Extracted {} withdrawal IDs from payloads", processed_withdrawals.len());

    // Step 4: Create new outpoint for the progress indication
    let new_outpoint_indication = Some(hyperlane_cosmos_rs::dymensionxyz::dymension::kas::TransactionOutpoint {
        transaction_id: new_utxo.transaction_id.as_bytes().to_vec(),
        index: new_utxo.index,
    });
    let anchor_outpoint_indication = Some(hyperlane_cosmos_rs::dymensionxyz::dymension::kas::TransactionOutpoint {
        transaction_id: anchor_utxo.transaction_id.as_bytes().to_vec(),
        index: anchor_utxo.index,
    });

    // Step 5: Create and return the ProgressIndication struct
    println!("Step 5: Creating ProgressIndication struct...");
    let progress_indication = ProgressIndication {
        old_outpoint: anchor_outpoint_indication,
        new_outpoint: new_outpoint_indication,
        processed_withdrawals,
    };

    println!("Progress indication preparation completed successfully!");
    println!("ProgressIndication: {:?}", progress_indication);

    Ok(progress_indication)
}

/// Parse withdrawal payloads to extract withdrawal IDs
/// This function takes the raw payload data and extracts the withdrawal IDs
/// that were encoded in the transaction payloads.
/// 
/// # Arguments
/// * `payloads` - Vector of raw payload data from transactions
/// 
/// # Returns
/// * `Result<Vec<WithdrawalId>, Error>` - Vector of parsed withdrawal IDs
fn parse_withdrawal_payloads(payloads: &[Vec<u8>]) -> Result<Vec<WithdrawalId>, Error> {
    let mut withdrawal_ids: Vec<WithdrawalId> = Vec::new();

    for (index, payload) in payloads.iter().enumerate() {
        println!("Parsing payload {}: {:?}", index, payload);
        
        // TODO: Implement proper payload parsing logic
        // For now, we'll create a placeholder withdrawal ID
        // This should be replaced with actual parsing logic based on the payload format
        
        if payload.len() >= 32 {
            // Assume the first 32 bytes contain the message ID
            let message_id_bytes = &payload[0..32];
            let message_id_hex = hex::encode(message_id_bytes);
            
            let withdrawal_id = WithdrawalId {
                message_id: message_id_hex,
            };
            
            println!("Extracted withdrawal ID: {:?}", withdrawal_id);
            withdrawal_ids.push(withdrawal_id);
        } else {
            println!("Payload {} too short, skipping", index);
        }
    }

    println!("Successfully parsed {} withdrawal IDs from {} payloads", withdrawal_ids.len(), payloads.len());
    Ok(withdrawal_ids)
}






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
    fn test_parse_withdrawal_payloads() {
        // Test with empty payloads
        let empty_payloads: Vec<Vec<u8>> = Vec::new();
        let result = parse_withdrawal_payloads(&empty_payloads);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);

        // Test with valid payload
        let test_payload = vec![1u8; 32]; // 32 bytes of 1s
        let payloads = vec![test_payload.clone()];
        let result = parse_withdrawal_payloads(&payloads);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 1);

        // Test with short payload
        let short_payload = vec![1u8; 16]; // Only 16 bytes
        let payloads = vec![short_payload];
        let result = parse_withdrawal_payloads(&payloads);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0); // Should skip short payloads
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
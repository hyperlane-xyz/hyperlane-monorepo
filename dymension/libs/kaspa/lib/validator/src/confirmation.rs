use crate::error::ValidationError;
use corelib::confirmation::ConfirmationFXG;
use std::cmp::min;

use corelib::api::client::HttpClient;

use api_rs::models::TxModel;
use corelib::payload::{MessageID, MessageIDs};
use corelib::util;
use kaspa_consensus_core::network::NetworkId;
use kaspa_consensus_core::tx::{TransactionId, TransactionInput, TransactionOutpoint};
use kaspa_hashes::Hash as KaspaHash;
use kaspa_rpc_core::RpcHash;
use kaspa_wallet_core::prelude::DynRpcApi;
use std::collections::HashSet;
use std::sync::Arc;
use tracing::{info, warn};
// FIXME: add address validation

pub async fn validate_confirmed_withdrawals(
    fxg: &ConfirmationFXG,
    kas_http: &HttpClient,
    kas_rpc: &Arc<DynRpcApi>,
    network_id: NetworkId,
) -> Result<(), ValidationError> {
    info!("Validator: Starting validation of withdrawals confirmation");

    let anchor_utxo = fxg
        .progress_indication
        .old_outpoint
        .as_ref()
        .ok_or_else(|| eyre::eyre!("Validator: Old outpoint missing in progress indication"))?;

    let new_utxo = fxg
        .progress_indication
        .new_outpoint
        .as_ref()
        .ok_or_else(|| eyre::eyre!("Validator: New outpoint missing in progress indication"))?;

    // Convert progress indication outpoints to kaspa consensus types for comparison
    let anchor_kaspa_outpoint = TransactionOutpoint {
        transaction_id: KaspaHash::from_bytes(
            anchor_utxo
                .transaction_id
                .as_slice()
                .try_into()
                .map_err(|e| {
                    eyre::eyre!("Validator: Invalid anchor outpoint transaction ID: {}", e)
                })?,
        ),
        index: anchor_utxo.index,
    };

    let new_kaspa_outpoint = TransactionOutpoint {
        transaction_id: KaspaHash::from_bytes(
            new_utxo.transaction_id.as_slice().try_into().map_err(|e| {
                eyre::eyre!("Validator: Invalid new outpoint transaction ID: {}", e)
            })?,
        ),
        index: new_utxo.index,
    };

    // Validate the progress indication is correct according to the cache
    let outpoints = &fxg.cache.outpoints;
    if outpoints.len() < 2 {
        return Err(ValidationError::SystemError(eyre::eyre!(
            "Validator: Insufficient outpoints in cache for validation"
        )));
    }
    if outpoints[0] != anchor_kaspa_outpoint {
        return Err(ValidationError::SystemError(eyre::eyre!(
            "Validator: Anchor outpoint mismatch in cache"
        )));
    }
    if outpoints[outpoints.len() - 1] != new_kaspa_outpoint {
        return Err(ValidationError::SystemError(eyre::eyre!(
            "Validator: New outpoint mismatch in cache"
        )));
    }

    let mut collected_message_ids = Vec::new();

    let dag_info = kas_rpc
        .get_block_dag_info()
        .await
        .map_err(|e| eyre::eyre!("Get block DAG info: {}", e))?;

    // Start from the next UTXO after the anchor_utxo (skip the first outpoint)
    for (i, curr_outpoint) in outpoints.iter().enumerate().skip(1) {
        info!(
            "Validator: Processing outpoint {} of {}: {:?}",
            i + 1,
            outpoints.len(),
            curr_outpoint
        );

        let tx_id = &curr_outpoint.transaction_id.to_string();

        // Get the transaction that CREATED this UTXO
        let transaction = kas_http.get_tx_by_id(tx_id).await.map_err(|e| {
            eyre::eyre!(
                "Validator: Failed to get transaction {}: {}",
                curr_outpoint.transaction_id,
                e
            )
        })?;

        // Validate that the tx is mature
        let block_hashes = &transaction
            .block_hash
            .clone()
            .ok_or_else(|| eyre::eyre!("Validator: No block hash found in transaction"))?;

        // Note: we do `get_block` (network call) for every tx block hash
        // which might create network overhead or trigger rate limit.
        // TODO: does it make sense to use some cache?
        let mut earlies_daa: u64 = 0;
        for hash in block_hashes {
            let hash = RpcHash::constructor(hash.as_str());
            let block = kas_rpc
                .get_block(hash, false)
                .await
                .map_err(|e| eyre::eyre!("Failed to get block {}: {}", hash, e))?;

            earlies_daa = min(earlies_daa, block.header.daa_score);
        }

        if !util::maturity::is_mature(earlies_daa, dag_info.virtual_daa_score, network_id) {
            return Err(ValidationError::ImmatureTransaction {
                tx_id: tx_id.clone(),
            });
        }

        // Validate that this transaction spends the previous outpoint
        let prev_outpoint = &outpoints[i - 1]; // Previous outpoint in the chain
        if !validate_previous_transaction_in_inputs(&transaction, prev_outpoint)? {
            return Err(ValidationError::SystemError(eyre::eyre!(
                "Validator: Previous transaction not found in inputs"
            )));
        }

        // Extract the messageID from the payload
        let payload = transaction
            .payload
            .clone()
            .ok_or_else(|| eyre::eyre!("No payload found in transaction"))?;

        let message_ids = MessageIDs::from_tx_payload(&payload)
            .map_err(|e| eyre::eyre!("Failed to parse message IDs from payload: {}", e))?;

        collected_message_ids.extend(message_ids.0);
    }

    // Assert that the collected messageIds are the same as progress_indication.processed_withdrawals
    validate_message_ids_match(fxg, &collected_message_ids)?;

    info!("Validator: All validations passed successfully");
    Ok(())
}

/// Validate that the previous transaction is referenced in the current transaction's inputs
fn validate_previous_transaction_in_inputs(
    transaction: &TxModel,
    prev_outpoint: &TransactionOutpoint,
) -> Result<bool, ValidationError> {
    let inputs = transaction
        .inputs
        .as_ref()
        .ok_or_else(|| eyre::eyre!("Validator: Transaction inputs not found"))?;

    for input in inputs {
        // Properly decode the hex values like in the relayer
        let input_utxo = TransactionOutpoint {
            transaction_id: kaspa_hashes::Hash::from_bytes(
                hex::decode(&input.previous_outpoint_hash)
                    .map_err(|e| eyre::eyre!("Invalid hex in previous_outpoint_hash: {}", e))?
                    .try_into()
                    .map_err(|_| eyre::eyre!("Invalid hex length in previous_outpoint_hash"))?,
            ),
            index: input
                .previous_outpoint_index
                .parse()
                .map_err(|e| eyre::eyre!("Failed to parse previous_outpoint_index: {}", e))?,
        };

        if input_utxo.transaction_id == prev_outpoint.transaction_id
            && input_utxo.index == prev_outpoint.index
        {
            return Ok(true);
        }
    }

    Ok(false)
}

/// Validate that the collected message IDs match the progress indication
fn validate_message_ids_match(
    fxg: &ConfirmationFXG,
    collected_message_ids: &[MessageID],
) -> Result<(), ValidationError> {
    // Convert collected message IDs to the same format as progress indication
    let expected_message_ids: HashSet<String> = collected_message_ids
        .iter()
        .map(|id| hex::encode(id.0.as_bytes()))
        .collect();

    let actual_message_ids: HashSet<String> = fxg
        .progress_indication
        .processed_withdrawals
        .iter()
        .map(|w| w.message_id.clone())
        .collect();

    if expected_message_ids != actual_message_ids {
        return Err(ValidationError::SystemError(eyre::eyre!(
            "Validator: Message IDs mismatch - expected: {:?}, actual: {:?}",
            expected_message_ids,
            actual_message_ids
        )));
    }

    Ok(())
}

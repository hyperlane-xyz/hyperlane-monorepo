use crate::error::ValidationError;
use corelib::confirmation::ConfirmationFXG;
use std::cmp::min;

use corelib::api::client::HttpClient;

use api_rs::models::TxModel;
use corelib::finality;
use corelib::payload::{MessageID, MessageIDs};
use corelib::util;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::ProgressIndication;
use kaspa_consensus_core::network::NetworkId;
use kaspa_consensus_core::tx::{TransactionId, TransactionInput, TransactionOutpoint};
use kaspa_hashes::Hash as KaspaHash;
use kaspa_rpc_core::RpcHash;
use kaspa_wallet_core::prelude::DynRpcApi;
use std::collections::HashSet;
use std::str::FromStr;
use std::sync::Arc;
use tracing::{info, warn};
// FIXME: add address validation

pub async fn validate_confirmed_withdrawals(
    fxg: &ConfirmationFXG,
    client_rest: &HttpClient,
) -> Result<(), ValidationError> {
    info!("Validator: Starting validation of withdrawals confirmation");

    let untrusted_progress = &fxg.progress_indication;

    let proposed_hub_anchor_old = {
        let o = untrusted_progress
            .old_outpoint
            .as_ref()
            .ok_or_else(|| eyre::eyre!("Validator: Old outpoint missing in progress indication"))?;
        TransactionOutpoint {
            transaction_id: KaspaHash::from_bytes(o.transaction_id.as_slice().try_into().map_err(
                |e| eyre::eyre!("Validator: Invalid anchor outpoint transaction ID: {}", e),
            )?),
            index: o.index,
        }
    };

    let proposed_hub_anchor_new = {
        let o = untrusted_progress
            .new_outpoint
            .as_ref()
            .ok_or_else(|| eyre::eyre!("Validator: New outpoint missing in progress indication"))?;
        TransactionOutpoint {
            transaction_id: KaspaHash::from_bytes(o.transaction_id.as_slice().try_into().map_err(
                |e| eyre::eyre!("Validator: Invalid new outpoint transaction ID: {}", e),
            )?),
            index: o.index,
        }
    };

    // Validate the progress indication is correct according to the cache
    let outpoint_sequence = &fxg.cache.outpoints;
    if outpoint_sequence.len() < 2 {
        return Err(ValidationError::SystemError(eyre::eyre!(
            "Validator: Insufficient outpoints in cache for validation"
        )));
    }
    if outpoint_sequence[0] != proposed_hub_anchor_old {
        return Err(ValidationError::SystemError(eyre::eyre!(
            "Validator: Anchor outpoint mismatch in cache"
        )));
    }
    if outpoint_sequence[outpoint_sequence.len() - 1] != proposed_hub_anchor_new {
        return Err(ValidationError::SystemError(eyre::eyre!(
            "Validator: New outpoint mismatch in cache"
        )));
    }

    let mut observed_message_ids = Vec::new();

    // Start from the next UTXO after the anchor_utxo (skip the first outpoint)
    for (i, o) in outpoint_sequence.iter().enumerate().skip(1) {
        info!(
            "Validator: Processing outpoint {} of {}: {:?}",
            i + 1,
            outpoint_sequence.len(),
            o
        );

        let tx_id = &o.transaction_id.to_string();

        // Get the transaction that CREATED this UTXO
        let tx = client_rest.get_tx_by_id(tx_id).await.map_err(|e| {
            eyre::eyre!(
                "Validator: Failed to get transaction {}: {}",
                o.transaction_id,
                e
            )
        })?;

        // Validate that this transaction spends the previous outpoint
        let prev = &outpoint_sequence[i - 1]; // Previous outpoint in the chain
        if !validate_previous_transaction_in_inputs(&tx, prev)? {
            return Err(ValidationError::SystemError(eyre::eyre!(
                "Validator: Previous transaction not found in inputs"
            )));
        }

        let p = tx
            .payload
            .clone()
            .ok_or_else(|| eyre::eyre!("No payload found in transaction"))?;

        let message_ids = MessageIDs::from_tx_payload(&p)
            .map_err(|e| eyre::eyre!("Failed to parse message IDs from payload: {}", e))?;

        // If the last TX in sequence is final then the others must be too
        if i == outpoint_sequence.len() - 1 {
            let hint = match tx.block_hash {
                Some(block_hashes) => {
                    if 0 < block_hashes.len() {
                        Some(block_hashes[0].clone())
                    } else {
                        None
                    }
                }
                None => None,
            };
            if !finality::is_safe_against_reorg(client_rest, &tx_id, hint).await? {
                return Err(ValidationError::NotSafeAgainstReorg {
                    tx_id: tx_id.clone(),
                });
            }
        }

        observed_message_ids.extend(message_ids.0);
    }

    // Assert that the collected messageIds are the same as progress_indication.processed_withdrawals
    validate_message_ids_exactly_equal(untrusted_progress, &observed_message_ids)?;

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
fn validate_message_ids_exactly_equal(
    untrusted_progress: &ProgressIndication,
    observed_message_ids: &[MessageID],
) -> Result<(), ValidationError> {
    let expected_message_ids: HashSet<String> = observed_message_ids
        .iter()
        .map(|id| hex::encode(id.0.as_bytes()))
        .collect();

    let untrusted_message_ids: HashSet<String> = untrusted_progress
        .processed_withdrawals
        .iter()
        .map(|w| w.message_id.clone())
        .collect();

    if expected_message_ids != untrusted_message_ids {
        return Err(ValidationError::SystemError(eyre::eyre!(
            "Validator: Message IDs mismatch - expected: {:?}, actual: {:?}",
            expected_message_ids,
            untrusted_message_ids
        )));
    }

    Ok(())
}

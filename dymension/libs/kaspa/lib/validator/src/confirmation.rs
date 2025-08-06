use crate::error::ValidationError;
use api_rs::models::{TxModel, TxOutput};
use corelib::api::client::HttpClient;
use corelib::confirmation::ConfirmationFXG;
use corelib::finality;
use corelib::payload::{MessageID, MessageIDs};
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::ProgressIndication;
use kaspa_addresses::Address;
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_hashes::Hash as KaspaHash;
use std::collections::HashSet;
use tracing::info;

// FIXME: add address validation

/// Validator is given a progress indication to sign, and a cache of outpoints,
/// that should start from the current hub anchor and end with the new one.
/// The validator checks that indeed that set of outpoints is from a real withdrawal
/// sequence on Kaspa chain.
pub async fn validate_confirmed_withdrawals(
    fxg: &ConfirmationFXG,
    client_rest: &HttpClient,
    escrow_address: &Address,
) -> Result<(), ValidationError> {
    info!("Validator: Starting validation of withdrawals confirmation");

    let untrusted_progress = &fxg.progress_indication;

    let proposed_hub_anchor_old = {
        let o = untrusted_progress.old_outpoint.as_ref().ok_or_else(|| {
            ValidationError::FailedGeneralVerification {
                reason: "Old outpoint missing in progress indication".to_string(),
            }
        })?;
        TransactionOutpoint {
            transaction_id: KaspaHash::from_bytes(o.transaction_id.as_slice().try_into().map_err(
                |e| ValidationError::FailedGeneralVerification {
                    reason: format!("Invalid anchor outpoint transaction ID: {}", e),
                },
            )?),
            index: o.index,
        }
    };

    let proposed_hub_anchor_new = {
        let o = untrusted_progress.new_outpoint.as_ref().ok_or_else(|| {
            ValidationError::FailedGeneralVerification {
                reason: "New outpoint missing in progress indication".to_string(),
            }
        })?;
        TransactionOutpoint {
            transaction_id: KaspaHash::from_bytes(o.transaction_id.as_slice().try_into().map_err(
                |e| ValidationError::FailedGeneralVerification {
                    reason: format!("Invalid new outpoint transaction ID: {}", e),
                },
            )?),
            index: o.index,
        }
    };

    // Validate the progress indication is correct according to the cache
    let outpoint_sequence = &fxg.outpoints;
    if outpoint_sequence.len() < 2 {
        return Err(ValidationError::FailedGeneralVerification {
            reason: "Insufficient outpoints in cache for validation".to_string(),
        });
    }
    if outpoint_sequence[0] != proposed_hub_anchor_old {
        return Err(ValidationError::AnchorMismatch {
            o: proposed_hub_anchor_old,
        });
    }
    if outpoint_sequence[outpoint_sequence.len() - 1] != proposed_hub_anchor_new {
        return Err(ValidationError::AnchorMismatch {
            o: proposed_hub_anchor_new,
        });
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
            ValidationError::FailedGeneralVerification {
                reason: format!("Failed to get transaction {}: {}", o.transaction_id, e),
            }
        })?;

        // Validate that this transaction spends the previous outpoint
        let o_prev = &outpoint_sequence[i - 1]; // Previous outpoint in the chain
        if !outpoint_in_inputs(&tx, o_prev)? {
            return Err(ValidationError::FailedGeneralVerification {
                reason: "Previous transaction not found in inputs".to_string(),
            });
        }

        // Validate that this transaction creates the current outpoint
        escrow_outpoint_in_outputs(&tx, o, escrow_address)?;

        let p = tx
            .payload
            .clone()
            .ok_or_else(|| ValidationError::FailedGeneralVerification {
                reason: "No payload found in transaction".to_string(),
            })?;

        let message_ids = MessageIDs::from_tx_payload(&p).map_err(|e| {
            ValidationError::FailedGeneralVerification {
                reason: format!("Failed to parse message IDs from payload: {}", e),
            }
        })?;

        // If the last TX in sequence is final then the others must be too
        if i == outpoint_sequence.len() - 1 {
            let hint = match tx.block_hash {
                Some(block_hashes) => {
                    if !block_hashes.is_empty() {
                        Some(block_hashes[0].clone())
                    } else {
                        None
                    }
                }
                None => None,
            };
            if !finality::is_safe_against_reorg(client_rest, tx_id, hint).await? {
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

/// Validate that the previous outpoint is referenced in the current transaction's inputs
fn outpoint_in_inputs(
    transaction: &TxModel,
    anchor: &TransactionOutpoint,
) -> Result<bool, ValidationError> {
    let inputs =
        transaction
            .inputs
            .as_ref()
            .ok_or_else(|| ValidationError::FailedGeneralVerification {
                reason: "Transaction inputs not found".to_string(),
            })?;

    for input in inputs {
        // Properly decode the hex values like in the relayer
        let input_utxo = TransactionOutpoint {
            transaction_id: kaspa_hashes::Hash::from_bytes(
                hex::decode(&input.previous_outpoint_hash)
                    .map_err(|e| ValidationError::FailedGeneralVerification {
                        reason: format!("Invalid hex in previous_outpoint_hash: {}", e),
                    })?
                    .try_into()
                    .map_err(|_| ValidationError::FailedGeneralVerification {
                        reason: "Invalid hex length in previous_outpoint_hash".to_string(),
                    })?,
            ),
            index: input.previous_outpoint_index.parse().map_err(|e| {
                ValidationError::FailedGeneralVerification {
                    reason: format!("Failed to parse previous_outpoint_index: {}", e),
                }
            })?,
        };

        if input_utxo == *anchor {
            return Ok(true);
        }
    }

    Ok(false)
}

/// Validate that the anchor is referenced in the current transaction's outputs
/// and it is an escrow change
fn escrow_outpoint_in_outputs(
    tx_trusted: &TxModel,
    escrow_outpoint_unstrusted: &TransactionOutpoint,
    escrow_address: &Address,
) -> Result<(), ValidationError> {
    let outs =
        tx_trusted
            .outputs
            .as_ref()
            .ok_or_else(|| ValidationError::FailedGeneralVerification {
                reason: "Transaction outputs not found".to_string(),
            })?;

    let out_actual: &TxOutput = outs
        .get(escrow_outpoint_unstrusted.index as usize)
        .ok_or(ValidationError::NextAnchorNotFound)?;

    // We already know this TX spends escrow funds, so it must be signed by validators
    // Validators only sign withdrawals containing exactly one change output back to the escrow
    // So this must be the unique change output
    let recipient_actual = out_actual
        .script_public_key_address
        .clone()
        .ok_or_else(|| ValidationError::FailedGeneralVerification {
            reason: "No script public key address found in anchor output".to_string(),
        })?;

    if recipient_actual != escrow_address.address_to_string() {
        return Err(ValidationError::NonEscrowAnchor {
            o: *escrow_outpoint_unstrusted,
        });
    }

    Ok(())
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
        return Err(ValidationError::FailedGeneralVerification {
            reason: format!(
                "Message IDs mismatch - expected: {:?}, actual: {:?}",
                expected_message_ids, untrusted_message_ids
            ),
        });
    }

    Ok(())
}

use std::str::FromStr;

use hyperlane_aleo::{AleoGetMappingValue, AleoProviderForLander, Plaintext};

use crate::payload::PayloadDetails;
use crate::transaction::Transaction;
use crate::{LanderError, TransactionStatus};

impl<P: AleoProviderForLander> crate::adapter::chains::aleo::adapter::core::AleoAdapter<P> {
    /// Check which payloads were reverted by verifying on-chain delivery status.
    ///
    /// For Aleo:
    /// - **Finalized** transactions: Query on-chain to verify if the message was actually delivered
    ///   - If delivery record doesn't exist, the payload is reverted
    /// - **Dropped** transactions: All payloads are reverted
    /// - **Other** statuses (Mempool, PendingInclusion): Cannot determine yet, return empty
    pub(crate) async fn reverted(
        &self,
        tx: &Transaction,
    ) -> Result<Vec<PayloadDetails>, LanderError> {
        match &tx.status {
            TransactionStatus::Finalized => {
                // For finalized transactions, check on-chain if messages were actually delivered
                let mut reverted = Vec::new();

                for payload_detail in &tx.payload_details {
                    // Skip payloads without success_criteria
                    let Some(ref success_criteria_bytes) = payload_detail.success_criteria else {
                        continue;
                    };

                    // Parse the success_criteria to get the delivery check parameters
                    let get_mapping_value: AleoGetMappingValue =
                        serde_json::from_slice(success_criteria_bytes).map_err(|e| {
                            LanderError::NonRetryableError(format!(
                                "Failed to parse success_criteria: {e}"
                            ))
                        })?;

                    // Parse the mapping key - if parsing fails, skip this payload
                    let Ok(key) = Plaintext::from_str(&get_mapping_value.mapping_key) else {
                        // Cannot parse, skip verification for this payload
                        continue;
                    };

                    // Query on-chain to check if the delivery record exists
                    // If provider returns error, treat as delivered (not reverted) with unwrap_or(true)
                    let delivered = self
                        .provider
                        .mapping_value_exists(
                            &get_mapping_value.program_id,
                            &get_mapping_value.mapping_name,
                            &key,
                        )
                        .await
                        .unwrap_or(true);

                    // If not delivered, the payload is reverted
                    if !delivered {
                        reverted.push(payload_detail.clone());
                    }
                }

                Ok(reverted)
            }
            TransactionStatus::Dropped(_) => {
                // For dropped transactions, all payloads, independently if they have
                // success criteria or not, are reverted
                Ok(tx.payload_details.clone())
            }
            _ => {
                // Transaction not confirmed yet (Mempool or PendingInclusion)
                // Cannot determine if payloads are reverted
                Ok(Vec::new())
            }
        }
    }
}

#[cfg(test)]
mod tests;

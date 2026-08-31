use std::str::FromStr;

use hyperlane_aleo::{AleoGetMappingValue, AleoProviderForLander, Plaintext};

use crate::payload::PayloadDetails;
use crate::transaction::Transaction;
use crate::{LanderError, TransactionStatus};

impl<P: AleoProviderForLander> crate::adapter::chains::aleo::adapter::core::AleoAdapter<P> {
    async fn payload_delivered(
        &self,
        payload_detail: &PayloadDetails,
    ) -> Result<Option<bool>, LanderError> {
        let Some(ref success_criteria_bytes) = payload_detail.success_criteria else {
            return Ok(None);
        };
        let get_mapping_value: AleoGetMappingValue = serde_json::from_slice(success_criteria_bytes)
            .map_err(|e| {
                LanderError::NonRetryableError(format!("Failed to parse success_criteria: {e}"))
            })?;

        self.provider
            .mapping_value_exists(
                &get_mapping_value.program_id,
                &get_mapping_value.mapping_name,
                &get_mapping_value.mapping_key,
            )
            .await
            .map(Some)
            .map_err(LanderError::from)
    }

    /// Returns true only when every payload has a success criterion that is satisfied on-chain.
    pub(crate) async fn delivered(&self, tx: &Transaction) -> Result<bool, LanderError> {
        if tx.payload_details.is_empty() {
            return Ok(false);
        }
        for payload_detail in &tx.payload_details {
            if self.payload_delivered(payload_detail).await? != Some(true) {
                return Ok(false);
            }
        }
        Ok(true)
    }

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
                    if self.payload_delivered(payload_detail).await? == Some(false) {
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

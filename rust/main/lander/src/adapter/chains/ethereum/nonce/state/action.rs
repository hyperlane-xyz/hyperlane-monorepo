use hyperlane_core::U256;

use super::NonceManagerState;

use crate::{adapter::chains::ethereum::nonce::error::NonceResult, LanderError, TransactionUuid};

impl NonceManagerState {
    /// Reset upper nonce to the desired nonce.
    /// In the process, also clearing all the nonces/tx_uuid mappings between
    /// [desired_nonce, current_upper_nonce]
    pub async fn reset_upper_nonce(&self, desired_nonce: Option<u64>) -> Result<U256, LanderError> {
        tracing::debug!(?desired_nonce, "Resetting to new upper nonce");

        let current_finalized_nonce = self
            .get_finalized_nonce()
            .await?
            .ok_or_else(|| LanderError::EyreError(eyre::eyre!("No finalized nonce found")))?;

        // The new upper nonce we want to set
        let desired_upper_nonce = match desired_nonce {
            Some(s) => U256::from(s),
            None => {
                tracing::debug!(
                    finalized_nonce = current_finalized_nonce.as_u64(),
                    "No upper nonce provided, using finalized nonce"
                );
                current_finalized_nonce
            }
        };

        let current_upper_nonce = self.get_upper_nonce().await?;
        // we don't want to set the desired upper nonce even higher than current
        if current_upper_nonce <= desired_upper_nonce {
            let err = LanderError::EyreError(eyre::eyre!(
                "desired_upper_nonce higher than current_upper_nonce"
            ));
            return Err(err);
        }
        if desired_upper_nonce < current_finalized_nonce {
            let err = LanderError::EyreError(eyre::eyre!(
                "desired_upper_nonce lower than current_finalized_nonce"
            ));
            return Err(err);
        }

        // set upper nonce in the db
        self.set_upper_nonce(&desired_upper_nonce).await?;

        // We need to clear all nonces between [desired_upper_nonce, current_upper_nonce]
        let mut nonce_to_clear = desired_upper_nonce;
        while nonce_to_clear < current_upper_nonce {
            let tx_uuid = self.get_tracked_tx_uuid(&nonce_to_clear).await?;

            if tx_uuid == TransactionUuid::default() {
                nonce_to_clear = nonce_to_clear.saturating_add(U256::one());
                continue;
            }

            tracing::debug!(
                nonce = nonce_to_clear.as_u64(),
                ?tx_uuid,
                "Clearing nonce and tx uuid"
            );

            self.clear_tracked_tx_uuid(&nonce_to_clear)
                .await
                .map_err(|err| {
                    tracing::error!(?err, ?nonce_to_clear, "Failed to clear tx uuid");
                    err
                })?;
            self.clear_tracked_tx_nonce(&tx_uuid).await.map_err(|err| {
                tracing::error!(?err, ?nonce_to_clear, "Failed to clear tx nonce");
                err
            })?;
            nonce_to_clear = nonce_to_clear.saturating_add(U256::one());
        }
        Ok(desired_upper_nonce)
    }
}

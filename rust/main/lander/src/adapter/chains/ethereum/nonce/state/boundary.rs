use hyperlane_core::U256;
use tracing::{info, warn};

use super::super::db::ReorgedNonceRange;
use super::super::error::NonceResult;
use super::NonceManagerState;

impl NonceManagerState {
    /// Updates the boundary nonces based on the provided finalized nonce.
    ///
    /// Finalized nonce is the last known nonce that has been finalized on the chain, i.e.,
    /// it is the number of transactions which were committed by the account.
    ///
    /// Upper nonce is the possible next nonce assuming that all the transactions in flight
    /// will be committed. If there is tracked nonce which was assigned to a dropped transaction,
    /// it will be used as the next nonce.
    #[cfg(test)]
    pub(crate) async fn update_boundary_nonces(&self, finalized_nonce: &U256) -> NonceResult<()> {
        self.update_boundary_nonces_from_chain(Some(finalized_nonce))
            .await
    }

    /// Updates boundary nonces and durably records any finalized nonce regression.
    ///
    /// The pending range is stored before the finalized boundary. A crash between
    /// those writes can cause duplicate reprocessing, but cannot lose a regression.
    pub(crate) async fn update_boundary_nonces_from_chain(
        &self,
        finalized_nonce: Option<&U256>,
    ) -> NonceResult<()> {
        let _guard = self.boundary_update_lock.lock().await;
        let old_finalized_nonce = self.get_finalized_nonce().await?;
        let existing_range = self.get_reorged_nonce_range_unlocked().await?;

        let pending_range = if let Some(old_finalized_nonce) =
            old_finalized_nonce.filter(|old| finalized_nonce.is_none_or(|new| new < old))
        {
            let observed_range = ReorgedNonceRange {
                start: finalized_nonce
                    .map(|nonce| nonce.saturating_add(U256::one()))
                    .unwrap_or_default(),
                end: old_finalized_nonce,
            };
            let merged_range =
                existing_range.map_or(observed_range, |existing| ReorgedNonceRange {
                    start: existing.start.min(observed_range.start),
                    end: existing.end.max(observed_range.end),
                });
            self.nonce_db
                .store_reorged_nonce_range_by_signer_address(&self.address, &merged_range)
                .await?;
            warn!(
                ?old_finalized_nonce,
                ?finalized_nonce,
                ?observed_range,
                ?existing_range,
                ?merged_range,
                "Finalized nonce regressed; persisted transactions for reprocessing"
            );
            Some(merged_range)
        } else {
            existing_range
        };

        let recovered_range = pending_range.filter(|pending_range| {
            finalized_nonce.is_some_and(|finalized_nonce| finalized_nonce >= &pending_range.end)
        });

        match finalized_nonce {
            Some(finalized_nonce) => self.set_finalized_nonce(finalized_nonce).await?,
            None => {
                self.nonce_db
                    .clear_finalized_nonce_by_signer_address(&self.address)
                    .await?
            }
        }

        let mut upper_nonce = self.get_upper_nonce().await?;

        if let Some(finalized_nonce) =
            finalized_nonce.filter(|finalized_nonce| *finalized_nonce >= &upper_nonce)
        {
            // If the finalized nonce is greater than or equal to the upper nonce, it means that
            // some transactions were finalized by a service different from Lander.
            // And we need to update the upper nonce.
            upper_nonce = finalized_nonce.saturating_add(U256::one());
            self.set_upper_nonce(&upper_nonce).await?;
        }

        self.metrics
            .set_finalized_nonce(finalized_nonce.unwrap_or(&U256::zero()));
        self.metrics.set_upper_nonce(&upper_nonce);

        // Keep re-enqueuing pending transactions until the chain proves recovery.
        // Persist the recovered finalized boundary before clearing the range so a
        // crash can cause duplicates, but cannot make a later regression invisible.
        if let Some(recovered_range) = recovered_range {
            self.nonce_db
                .clear_reorged_nonce_range_by_signer_address(&self.address)
                .await?;
            info!(
                ?finalized_nonce,
                ?recovered_range,
                "Finalized nonce recovered; cleared persisted reprocessing range"
            );
        }

        Ok(())
    }

    pub(crate) async fn get_reorged_nonce_range(&self) -> NonceResult<Option<ReorgedNonceRange>> {
        let _guard = self.boundary_update_lock.lock().await;
        self.get_reorged_nonce_range_unlocked().await
    }

    async fn get_reorged_nonce_range_unlocked(&self) -> NonceResult<Option<ReorgedNonceRange>> {
        Ok(self
            .nonce_db
            .retrieve_reorged_nonce_range_by_signer_address(&self.address)
            .await?)
    }
}

#[cfg(test)]
mod tests;

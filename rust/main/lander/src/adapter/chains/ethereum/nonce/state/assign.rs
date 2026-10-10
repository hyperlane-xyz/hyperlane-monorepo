use tracing::{debug, instrument, warn};

use hyperlane_core::U256;

use crate::transaction::TransactionUuid;

use super::super::error::{NonceError, NonceResult};
use super::super::status::NonceStatus;
use super::NonceManagerState;

impl NonceManagerState {
    #[instrument(skip(self), fields(?tx_uuid, ?old_nonce))]
    pub(crate) async fn assign_next_nonce(
        &self,
        tx_uuid: &TransactionUuid,
        old_nonce: &Option<U256>,
    ) -> NonceResult<U256> {
        // Serialize with boundary updates, which may lower the upper nonce past freed nonces.
        let _guard = self.boundary_update_lock.lock().await;
        if let Some(nonce) = old_nonce {
            // Only clear nonce and tx_uuid linkage if the old_nonce is indeed associated with the tx_uuid in question
            if *tx_uuid == self.get_tracked_tx_uuid(nonce).await? {
                // If the different nonce was assigned to the transaction,
                // we clear the tracked nonce for the transaction first.
                warn!(
                    ?nonce,
                    "Reassigning nonce to transaction, clearing currently tracked nonce"
                );
                self.clear_tracked_tx_uuid(nonce).await?;
                self.clear_tracked_tx_nonce(tx_uuid).await?;
            }
        }

        let (finalized_nonce, upper_nonce) = self.get_boundary_nonces().await?;

        debug!(
            ?finalized_nonce,
            ?upper_nonce,
            "Identifying next nonce for transaction"
        );

        let next_nonce = self
            .identify_next_nonce(finalized_nonce, upper_nonce)
            .await?;
        if next_nonce == upper_nonce {
            // If we reached the upper nonce, we need to update it.
            self.set_upper_nonce(&(next_nonce.saturating_add(U256::one())))
                .await?;
        }

        self.set_tracked_tx_uuid(&next_nonce, tx_uuid).await?;

        Ok(next_nonce)
    }

    #[instrument(skip(self), fields(?finalized_nonce, ?upper_nonce))]
    async fn identify_next_nonce(
        &self,
        finalized_nonce: Option<U256>,
        upper_nonce: U256,
    ) -> Result<U256, NonceError> {
        // finalized_nonce is the last committed nonce on-chain.
        // When Some, nonces [0..=finalized] are committed, so scan from finalized+1.
        // When None (fresh account, 0 txs on-chain), scan from nonce 0.
        let scan_start = match finalized_nonce {
            Some(f) => f.saturating_add(U256::one()),
            None => U256::zero(),
        };

        let mut next_nonce = scan_start;

        while next_nonce < upper_nonce {
            if self.nonce_available(&next_nonce).await? {
                return Ok(next_nonce);
            }
            next_nonce = next_nonce.saturating_add(U256::one());
        }

        Ok(next_nonce)
    }

    /// A nonce is available if it is untracked, tracked by a missing transaction,
    /// or tracked by a transaction whose nonce is Freed (dropped).
    pub(super) async fn nonce_available(&self, nonce: &U256) -> NonceResult<bool> {
        let tracked_tx_uuid = self.get_tracked_tx_uuid(nonce).await?;
        if tracked_tx_uuid == TransactionUuid::default() {
            debug!(
                ?nonce,
                "There is no tracked transaction for nonce, reusing it"
            );
            return Ok(true);
        }

        let Some(tx) = self.get_tracked_tx(&tracked_tx_uuid).await? else {
            // If the transaction is not found, it means that the nonce was assigned to
            // a non-existing transaction. This should never happen. We assign new nonce.
            warn!(
                ?nonce,
                ?tracked_tx_uuid,
                "Nonce was assigned to a non-existing transaction, assigning new nonce"
            );
            return Ok(true);
        };

        let tx_nonce_status = NonceStatus::calculate_nonce_status(tx.uuid.clone(), &tx.status);
        if matches!(tx_nonce_status, NonceStatus::Freed(_)) {
            // If the transaction, which is tracked by the nonce, was dropped,
            // we can re-use the nonce.
            debug!(
                ?nonce,
                ?tracked_tx_uuid,
                "Transaction is freed, reusing nonce"
            );
            return Ok(true);
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests;

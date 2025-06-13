use tracing::warn;

use hyperlane_core::U256;

use crate::transaction::TransactionUuid;

use super::super::error::{NonceError, NonceResult};
use super::super::status::NonceStatus;
use super::NonceManagerState;

impl NonceManagerState {
    pub(crate) async fn assign_next_nonce(
        &self,
        tx_uuid: &TransactionUuid,
        current_tx_nonce: &Option<U256>,
    ) -> NonceResult<U256> {
        if let Some(nonce) = current_tx_nonce {
            // If different nonce was assigned to the transaction,
            // we clear the tracked nonce for the transaction first.
            warn!(
                ?nonce,
                "Reassigning nonce to transaction, clearing currently tracked nonce"
            );
            self.clear_tracked_tx_uuid(nonce).await?;
        }

        let (finalized_nonce, upper_nonce) = self.get_boundary_nonces().await?;

        let next_nonce = self
            .identify_next_nonce(finalized_nonce, upper_nonce)
            .await?;

        if next_nonce == upper_nonce {
            // If we reached the upper nonce, we need to update it.
            self.set_upper_nonce(&(next_nonce + 1)).await?;
        }

        self.set_tracked_tx_uuid(&next_nonce, tx_uuid).await?;

        Ok(next_nonce)
    }

    async fn identify_next_nonce(
        &self,
        finalized_nonce: Option<U256>,
        upper_nonce: U256,
    ) -> Result<U256, NonceError> {
        use NonceStatus::Freed;

        let Some(finalized_nonce) = finalized_nonce else {
            // If there is no finalized nonce, upper nonce should be zero, and we can use it as
            // the next nonce.
            return Ok(upper_nonce);
        };

        let mut next_nonce = finalized_nonce;

        while next_nonce < upper_nonce {
            let tracked_tx_uuid = self.get_tracked_tx_uuid(&next_nonce).await?;

            if tracked_tx_uuid == TransactionUuid::default() {
                // If the nonce is not tracked, we can use it.
                break;
            }

            let Some(tx) = self.get_tracked_tx(&tracked_tx_uuid).await? else {
                // If the transaction is not found, it means that the nonce was assigned to
                // a non-existing transaction. This should never happen. We assign new nonce.
                warn!(
                    ?next_nonce,
                    ?tracked_tx_uuid,
                    "Nonce was assigned to a non-existing transaction, assigning new nonce"
                );
                break;
            };

            let tx_status = tx.status;
            let tx_nonce_status = NonceStatus::calculate_nonce_status(tx.uuid.clone(), &tx_status);

            if matches!(tx_nonce_status, Freed(_)) {
                // If the transaction, which is tracked by the nonce, was dropped,
                // we can re-use the nonce.
                break;
            }

            next_nonce += U256::one();
        }

        Ok(next_nonce)
    }
}

#[cfg(test)]
mod tests;

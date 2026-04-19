use tracing::warn;

use hyperlane_core::U256;

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
    pub(crate) async fn update_boundary_nonces(&self, finalized_nonce: &U256) -> NonceResult<()> {
        self.set_finalized_nonce(finalized_nonce).await?;

        let mut upper_nonce = self.get_upper_nonce().await?;

        if finalized_nonce >= &upper_nonce {
            // If the finalized nonce is greater than or equal to the upper nonce, it means that
            // some transactions were finalized by a service different from Lander.
            // And we need to update the upper nonce.
            upper_nonce = finalized_nonce.saturating_add(U256::one());
            self.set_upper_nonce(&upper_nonce).await?;
        }

        self.metrics.set_finalized_nonce(finalized_nonce);
        self.metrics.set_upper_nonce(&upper_nonce);

        Ok(())
    }

    /// Resets the boundary nonces to the "no transactions seen" state.
    ///
    /// Called when the on-chain account has zero transactions on the
    /// finalized block (e.g. after a chain reset / testnet wipe). Without
    /// this, persisted state from the previous chain era poisons every
    /// subsequent nonce assignment until the operator manually wipes the
    /// RocksDB directory.
    ///
    /// The reset is conditional and idempotent: if nothing is persisted,
    /// it is a no-op. Otherwise both `finalized_nonce` (cleared) and
    /// `upper_nonce` (set to 0) are returned to their genesis values.
    pub(crate) async fn reset_boundary_nonces(&self) -> NonceResult<()> {
        let finalized_nonce = self.get_finalized_nonce().await?;
        let upper_nonce = self.get_upper_nonce().await?;

        if finalized_nonce.is_none() && upper_nonce.is_zero() {
            // Already at genesis; nothing to do.
            return Ok(());
        }

        warn!(
            ?finalized_nonce,
            ?upper_nonce,
            "Detected on-chain nonce reset; clearing stale boundary nonces",
        );

        self.clear_finalized_nonce().await?;
        self.set_upper_nonce(&U256::zero()).await?;

        // Mirror the cleared state in metrics. We surface 0 for finalized
        // because the gauge cannot represent "absent" — observers should
        // read it together with `upper_nonce == 0` to infer the reset.
        self.metrics.set_finalized_nonce(&U256::zero());
        self.metrics.set_upper_nonce(&U256::zero());

        Ok(())
    }
}

#[cfg(test)]
mod tests;

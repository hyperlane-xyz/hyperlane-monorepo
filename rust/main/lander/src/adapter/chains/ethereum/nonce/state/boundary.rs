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
    pub(crate) async fn update_boundary_nonces(&self, nonce: &U256) -> NonceResult<()> {
        self.set_finalized_nonce(nonce).await?;

        let upper_nonce = self.get_upper_nonce().await?;

        if nonce >= &upper_nonce {
            // If the finalized nonce is greater than or equal to the upper nonce, it means that
            // some transactions were finalized by a service different from Lander.
            // And we need to update the upper nonce.
            self.set_upper_nonce(&(nonce + 1)).await?;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests;

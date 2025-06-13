use hyperlane_core::U256;

use super::super::error::NonceResult;
use super::NonceManagerState;

impl NonceManagerState {
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

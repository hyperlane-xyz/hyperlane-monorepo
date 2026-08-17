use std::sync::Arc;
use std::time::Duration;

use hyperlane_core::U256;
use hyperlane_ethereum::{EthereumReorgPeriod, EvmProviderForLander};

use ethers_core::types::Address;
use tokio::sync::Mutex;
use tokio::time::Instant;

use super::error::{NonceError, NonceResult};
use super::state::NonceManagerState;

pub struct NonceUpdater {
    address: Address,
    reorg_period: EthereumReorgPeriod,
    block_time: Duration,
    provider: Arc<dyn EvmProviderForLander>,
    state: Arc<NonceManagerState>,
    updated: Arc<Mutex<Instant>>,
}

impl NonceUpdater {
    pub fn new(
        address: Address,
        reorg_period: EthereumReorgPeriod,
        block_time: Duration,
        provider: Arc<dyn EvmProviderForLander>,
        state: Arc<NonceManagerState>,
    ) -> Self {
        let instant = Instant::now()
            // Subtract the block time to ensure the first update happens
            // on the first request to update the lowest nonce.
            .checked_sub(block_time)
            // If the subtraction fails (which is unlikely), use the current time
            // In this case, the lowest nonce will be updated after
            // the block time has passed.
            .unwrap_or_else(Instant::now);
        let updated = Arc::new(Mutex::new(instant));

        NonceUpdater {
            address,
            reorg_period,
            block_time,
            provider,
            state,
            updated,
        }
    }

    pub async fn update_boundaries(&self) -> NonceResult<()> {
        let mut updated = self.updated.lock().await;
        if updated.elapsed() >= self.block_time {
            self.update_boundaries_immediately().await?;
            *updated = Instant::now();
        }

        Ok(())
    }

    async fn update_boundaries_immediately(&self) -> NonceResult<()> {
        let next_nonce = self
            .provider
            .get_next_nonce_on_finalized_block(&self.address, &self.reorg_period)
            .await
            .map_err(NonceError::ProviderError)?;

        let finalized_nonce = next_nonce.checked_sub(U256::one());
        self.state
            .update_boundary_nonces_from_chain(finalized_nonce.as_ref())
            .await?;

        Ok(())
    }
}

#[cfg(test)]
mod tests;
